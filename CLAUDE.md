# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Telegram (and optionally Slack) → Claude Code gateway. The Node.js process runs a Telegraf bot, and — when Slack env vars are set — also a Slack Bolt app in Socket Mode. Both transports feed each incoming message to `@anthropic-ai/claude-agent-sdk`'s `query()` through a shared core (`buildBot`'s `kickOffTurn`), then stream Claude's response back to the chat. Tool calls Claude wants to make are routed through inline buttons (Telegram inline keyboard / Slack Block Kit actions — same `Allow / Always / Deny / Never` set) before they execute. There is no web UI; the bots themselves are the only interfaces.

**Single process, dual transport.** Slack is opt-in via `.env` (`SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` + `ALLOWED_SLACK_USER_IDS`). When all three are set, the same Node process runs both transports, sharing `data/config.json`, sessions, scheduler, approvals, and per-user/per-chat state. With any missing, Slack stays off and the bot is Telegram-only — no regression. Slack channel/user ids ("C…", "U…") and Telegram numeric ids share the same string keyspace inside `data/config.json` and the in-memory turn queue without colliding.

## Commands

```bash
npm run dev        # scripts/dev.mjs — watches src/, defers reloads while data/.busy exists
npm start          # one-shot run via tsx
npm run typecheck  # tsc --noEmit; the only "build" check (project is noEmit)
npm test           # node:test via tsx over src/**/*.test.ts
```

`npm run dev` is a custom runner (`scripts/dev.mjs`), not `tsx watch`: it spawns the bot with plain `tsx`, watches `src/`, and refuses to restart while `data/.busy` exists so an in-flight Claude turn is never cut off. Tests exist only where logic is dense enough to earn them (`handlers/trustPolicy.test.ts` — the permission matcher). There is no linter and no build artifacts. `tsx` runs `.ts` directly; `tsconfig.json` has `noEmit: true` and `allowImportingTsExtensions: true`, so all relative imports use the explicit `.ts` extension (`./app.ts`, not `./app`). Keep that convention when adding files.

Required env (see `.env.example`): `TELEGRAM_BOT_TOKEN`, `ALLOWED_TELEGRAM_USER_IDS` (comma-separated numeric Telegram user IDs — anything else is silently dropped by the auth middleware in `src/telegram/app.ts`). Optional: `CLAUDE_CODE_OAUTH_TOKEN` (otherwise the SDK reuses `~/.claude/.credentials.json`). Optional Slack: `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` + `ALLOWED_SLACK_USER_IDS` — all three together enable Slack; any missing keeps Slack off.

Per-user app behavior (workspace, permission mode, model, voice, tz) lives in `data/users/<telegram-user-id>.json` — auto-created from `userTemplate.json` on each authorized user's first message and reloaded on the next turn whenever the file changes (fs.watch with ~200ms debounce). Workspace / permissionMode / model can additionally be overridden **per chat** via the chat-layer in `data/sessions.json` so each Telegram group remembers its own settings independently of the user's other chats; the `/workspace` `/mode` `/model` `/cloudexpert` slash commands write to the chat layer in groups and the user layer in DMs. Deleting a user's JSON file does NOT revoke their access — auth is gated by `ALLOWED_TELEGRAM_USER_IDS`. The bot never edits `.env`.

## Architecture

Module map (everything lives in `src/`). The codebase splits cleanly into **core** (transport-agnostic), **telegram/** (Telegraf-coupled), and **slack/** (Slack Bolt-coupled). Anything in `core/` or `handlers/` should never `import` from `telegram/` or `slack/`.

**Top level**

- `index.ts` — entrypoint and lifecycle orchestrator. Loads config, hydrates state, builds the turn engine + Telegram app + (optional) Slack app, registers transports with the scheduler, consumes the restart marker (posting "✅ reloaded" to each chat via the matching transport), starts everything, and on SIGINT/SIGTERM runs the dual-transport graceful shutdown.
- `config.ts` — env parsing. `loadConfig()` returns `{ telegramBotToken, allowedUserIds, gatewayDir, slack? }`. The optional `slack` block is populated only when all three Slack env vars are set.
- `configValidate.ts` — pure validators (`parsePermissionMode`, `parseWhisperModel`, …) plus `validateUserConfig`, shared between `config.ts` and `state/users.ts`.

**`core/` — the shared turn engine**

- `core/turnEngine.ts` — `buildTurnEngine(config)` returns a `TurnEngine` with `kickOffTurn(io, chatId, userId, prompt, opts?)`, `abortTurn`, queue/in-flight introspection, and shutdown helpers. Owns the per-chat FIFO tail Promise queue, in-flight tracking, and the `runTurn` SDK loop. **This is the file you'll touch for behavior changes that apply to both transports.** No Telegraf or Slack imports.
- `core/budget.ts` — spend ceilings. `check()` gates a turn against the chat's month bucket, `recordSpend()` rolls the bucket and returns a one-shot 80% warning. See "Budgets" below.
- `core/taskRunner.ts` — background tasks (`/bg`): a Claude turn that runs *off* the chat queue, in its own git worktree, under its own budget, escalating instead of blocking on approvals. See "Background tasks" below.
- `core/ioRegistry.ts` — `Transport → (chatId, chatKind) => TurnIO` factory registry, so a task can report into a chat after the handler that started it has returned. Same shape as `scheduler/transport.ts`.

**`handlers/` — transport-agnostic shared code**

- `handlers/turnIO.ts` — the `TurnIO` interface only (`chatId`, `chatKind`, `transport`, `reply`, `editMessage`, `removeButtons`, `sendChatAction`, optional `sendVoice`/`sendAudio`). Each transport's adapter lives in its own folder.
- `handlers/approvals.ts` — in-memory map of `tool_use_id → resolver` for pending Allow/Deny prompts.
- `handlers/questions.ts` — handles the SDK's `AskUserQuestion` tool. Renders one question at a time using `TurnIO.reply` / `editMessage` with a `ButtonGrid`; supports single- and multi-select; resolves with `{ [question]: answerLabel }`.
- `handlers/streamingReply.ts` — live-edits a single message as Claude streams text. Pure `TurnIO` calls — no transport awareness.
- `handlers/toolApprovals.ts` — `buildCanUseTool` (the `CanUseTool` SDK callback) and `applyPermissionCallback` (settles a `perm:*` callback id and returns the verdict + UI strings). Each transport's `actions.ts` calls into `clickRouter.ts` rather than this directly.
- `handlers/trustPolicy.ts` — pure permission matcher: rule parsing (`Bash(npm run *)`), the per-tool canonicalizer table, glob semantics, grant expiry, and the pattern proposed on the "Always …" button. Covered by `trustPolicy.test.ts`. See "Trust policy" below.
- `handlers/clickRouter.ts` — transport-agnostic dispatch for `q:*` (AskUserQuestion), `perm:*` (tool approval) and `task:*` (background-task buttons) clicks. Both transports' `actions.ts` build a small `ClickContext` from their callback payload and call `dispatchQuestionClick` / `dispatchApprovalClick` / `dispatchTaskClick`; this module owns the audit log + post-click message edit.
- `handlers/commandShared.ts` — `MODE_ALIASES`, `MODEL_ALIASES`, `COMMAND_MENU`, `writeOverride`, `scopeNote`, `ChatKind` — small building blocks shared by the runner.
- `handlers/commandRunner.ts` — single source of truth for slash-command behavior. `runCommand(deps, name, args)` handles every command (`/help`, `/status`, `/mode`, `/model`, `/workspace`, `/ws`, `/cloudexpert`, `/init`, `/compact`, `/resume`, `/new`, `/cancel`, `/cost`, `/budget`, `/bg`, `/tasks`, `/task`, `/kill`, `/redo`, `/trust` (alias `/rules`), `/respond`, `/voice`, `/cron`, `/watch`) using `TurnIO`. Each transport's `commands.ts` is a thin adapter that builds `CommandDeps` and calls `runCommand`.
- `handlers/respondModes.ts` — `RespondMode` type + `VALID_RESPOND_MODES`. The actual respond-gate impl is per-transport because it inspects transport-native message metadata.
- `handlers/sessionSwitch.ts` — `maybeSwitchSession(deps, text)`: a message whose whole body is a session id switches the chat's live session instead of becoming a prompt. Both transports call it right before `kickOffTurn`; returns `true` when it consumed the message.

**`telegram/` — Telegraf transport**

- `telegram/app.ts` — `buildTelegramApp(config, engine, bootTime)`. Creates the Telegraf bot, wires auth middleware, registers commands/actions/media handlers, and exposes `start` / `stop` / `kickOffTurnFromCron` / `notifyChat` / `setMyCommands`. Mirror of `slack/app.ts`.
- `telegram/io.ts` — `ioFromContext(ctx)` and `ioFromTelegram(client, chatId)` build a `TurnIO` over the Telegraf client. Stringifies the chat id at the boundary; reverses with `Number(chatId)` when calling `bot.telegram.*`.
- `telegram/actions.ts` — `registerTelegramActions(bot)` wires `bot.on(callbackQuery("data"))` to forward `q:*` and `perm:*` clicks to the shared `clickRouter`. Also exports `safeAnswerCbQuery` for swallowing "query is too old" errors.
- `telegram/commands.ts` — thin Telegraf adapter: iterates `COMMAND_MENU` and registers a `bot.command(name, …)` for each, building a `CommandDeps` from `ctx` and calling `runCommand` in `handlers/commandRunner.ts`. All command logic (including `/cron list|pause|resume|delete`) lives in the runner — this file just bridges Telegraf↔runner.
- `telegram/mediaHandlers.ts` — `bot.on(message("photo" | "document" | "voice" | "audio"))`. Album debounce, image base64 attachment, file save to `<workspace>/.uploads/`, voice transcription via `services/voice/`.
- `telegram/respondGate.ts` — `shouldRespond(ctx)`: DM always responds; group consults `sessions.<chatId>.respondTo` and Telegram message entities for the @-mention check.
- `telegram/replyContext.ts` — `buildReplyContext(reply)` formats a short quote prefix when the user is replying to another message.

**`slack/` — Slack Bolt transport**

- `slack/app.ts` — `buildSlackApp(slack, config, engine, bootTime)`. Creates the Bolt app in Socket Mode, registers events + actions, exposes `start` / `stop` / `notifyChat`. Registers itself as the "slack" cron transport.
- `slack/io.ts` — `ioFromSlack(client, channelId, chatKind, threadTs?)` builds a `TurnIO` using `chat.postMessage` / `chat.update` and Block Kit `actions` blocks for `ButtonGrid`. When `threadTs` is set, all replies go into that thread.
- `slack/handlers.ts` — `registerSlackEvents(app, deps)` wires `message.im` (DMs) and `app_mention` (channels). Strips the `<@bot>` prefix from mentions, anchors the reply thread to `event.thread_ts ?? event.ts` so back-and-forth stays in-thread, dispatches `/cmd` to `slack/commands.ts`, otherwise calls `engine.kickOffTurn`.
- `slack/actions.ts` — `app.action(/^(?:perm|q):/)` block_actions handler that forwards to the shared `clickRouter` — mirror of `telegram/actions.ts`.
- `slack/commands.ts` — `dispatchSlackCommand` is a thin adapter that parses `/cmd args` and calls `handlers/commandRunner.ts → runCommand`. All command logic is shared with Telegram.
- `slack/format.ts` — small Markdown → Slack `mrkdwn` converter (only the link form `[t](u)` → `<u|t>` differs).

**`services/`**

- `services/claude.ts` — wraps the Agent SDK. `askClaude()` calls `query()`, accumulates assistant text, captures `session_id` and `total_cost_usd` from the `result` message, and forwards `PreToolUse` / `PostToolUse` / `PostToolUseFailure` hooks to `turnLog`. Throws `AskClaudeAbortedError` on signal abort.
- `services/claudeSessions.ts` — discovery over the on-disk Claude Code transcripts at `~/.claude/projects/<slug>/<sessionId>.jsonl` (the CLI and the SDK share these files, so resuming a CLI session needs only its id). `listSessions`, `describeSession`, `findExistingSession` (existence-checked id/prefix resolution), `searchSessions` (streaming substring search), `slugForWorkspace`.
- `services/sessionsMcp.ts` — per-turn `sessions` MCP server (`session_list` / `session_search` / `session_ask`) + `buildSessionsSystemGuidance()`. See "Cross-session context" below.
- `services/worktree.ts` — git plumbing for task isolation: `create` / `summarize` / `diffText` / `commitAll` / `merge` / `discard`. All `execFile` with argument arrays, never a shell.
- `services/voice/` — Whisper transcription + TTS synthesis (Telegram-side only for now).

**`state/`**

- `state/store.ts` — owns `data/config.json` (consolidated per-user + per-chat state). `load()`, `persist()`, `watch()` (200ms-debounced fs.watch). Schema: `{ users: { "<userId>": UserConfig }, sessions: { "<chatId>": ChatState } }`. Telegram numeric ids and Slack string ids share the same key namespace without colliding. Atomic `tmp + rename` writes.
- `state/sessions.ts` — thin wrapper over `store.ts`. `get(chatId)` / `update(chatId, patch)` accept `number | string`. State carried: `sessionId`, `totalCostUsd`, `allowAlwaysTools[]`, `denyAlwaysTools[]`, plus optional per-chat overrides `workspaceDir` / `permissionMode` / `model`.
- `state/users.ts` — thin wrapper over `store.ts`. All API surface accepts `number | string` user ids (Telegram numerics, Slack `U…`). `ensure(userId)` seeds from `userTemplate.json` on a user's first message. Helpers `effectiveWorkspace`, `effectiveMode`, `effectiveModel` consult chat → user → default; `voiceFor` and `tzFor` are user-only.
- `state/tasks.ts` — atomic JSON store at `data/tasks.json` for background tasks. Same shape as `crons.ts` minus the fs.watch (runtime state nobody hand-edits; a reload racing a status write would lose progress). Terminal rows are pruned after 7 days. `markInterruptedOnBoot()` reconciles rows a restart killed.
- `state/watchers.ts` — atomic JSON store at `data/watchers.json` for event triggers (`/watch`).
- `state/crons.ts` — atomic JSON store at `data/crons.json` keyed by cron id. Each row carries `transport: "telegram" | "slack"` so a cron created from a Slack channel fires back to Slack and vice versa. Legacy untagged rows migrate to `transport: "telegram"` on first load.
- `state/restart-marker.ts` — `data/restart-marker.json` with `chats: RestartChat[]` (each `{ chatId, transport }`). Legacy `chats: number[]` markers migrate to telegram entries.
- `state/turnLog.ts` — append-only `data/turns.jsonl` of pre/post tool events.
- `state/logger.ts` — daily JSON logs at `data/logs/YYYY-MM-DD.jsonl`. Categories: `error` / `turn` / `approval` / `cron` / `lifecycle`. `userId` accepts both `number` and `string` so Slack ids serialize cleanly.

**`watchers/`**

- `watchers/sources.ts` — the four probe implementations (`git` / `fs` / `http` / `log`). Each answers "what does this look like now?" as a short fingerprint and never fires or mutates anything, so the change decision lives in one place. Also `validateTarget`, so a typo fails in chat instead of silently never firing.
- `watchers/ticker.ts` — one 30s `setInterval` for all watchers; per-row `intervalSec`, baseline-on-first-check, and dispatch into `taskRunner.startTask`. Mirrors `scheduler/ticker.ts`.

**`scheduler/`**

- `scheduler/mcp.ts` — `buildSchedulerMcp(chatId, userId, tz, transport)` returns the per-turn SDK MCP server exposing `cron_create` / `cron_list` / `cron_update` / `cron_delete` (closed over the current chat + transport so a Slack cron records `transport: "slack"` and fires back to Slack). `buildSchedulerSystemGuidance(tz, userId, chatId, isGroup)` is the per-turn system-prompt addendum.
- `scheduler/transport.ts` — small `Transport → kickOffTurnFromCron` registry. `index.ts` registers `"telegram"` (from `telegram/app.ts`) and `slack/app.ts` registers `"slack"` itself.
- `scheduler/runner.ts` — `fire(c, lateMs)` builds the prompt and dispatches via the registry.
- `scheduler/ticker.ts` — single `setInterval(60s)` that finds due jobs via `cron-parser` (TZ resolved per row), reserves the slot via `lastFiredAt`, then fires. Catch-up window 30 minutes.

### Per-user / per-chat state model

Two stores, layered for the three "behavior" settings (workspace / permissionMode / model):

- **Per-user app config** (`state/users.ts`, JSON path `data/config.json#users.<userId>`) — workspace, permission mode, model, voice settings, tz, name, notes. The user-level *default*: applies to DMs and to any group that hasn't set its own override. Editable by hand, by Claude (Edit/Write `data/config.json`), or by the slash commands when used from a DM. Auto-reloaded via the `store.watch()` fs.watch.
- **Per-chat runtime state** (`state/sessions.ts`, JSON path `data/config.json#sessions.<chatId>`) — active Claude `sessionId`, cumulative `totalCostUsd`, per-tool `allowAlwaysTools[]` / `denyAlwaysTools[]`, plus optional per-chat overrides for `workspaceDir` / `permissionMode` / `model`. The override layer is what lets the user have a different workspace per Telegram group. The slash commands `/workspace` `/mode` `/model` `/cloudexpert` write to the chat layer in groups (where `chat.type !== "private"`) and to the user layer in DMs.

Both layers live in the **same** file, `data/config.json` — that's the only file you need to copy between machines to reproduce behavior.

Resolvers `users.effectiveWorkspace(chatId, userId, gatewayDir)`, `users.effectiveMode(chatId, userId)`, `users.effectiveModel(chatId, userId)` consult chat → user → default. Always use them instead of reading fields directly. `users.tzFor(userId)` and `users.voiceFor(userId)` stay user-only — those settings don't sensibly differ per-chat.

Note: external edits to `data/config.json` (whether from Claude in a turn or a hand-edit) are picked up by the watcher on the next turn for both layers. The bot still does its own writes, so a Claude edit racing a `sessions.update()` could be clobbered — for chat-layer changes prefer the slash commands; for user-layer defaults, hand-edit / Claude-edit is fine.

`MODEL_ALIASES` maps friendly names (`opus` / `sonnet` / `haiku` / `default`) to SDK model IDs. `default` resolves to empty string, meaning "let the SDK pick."

### Turn lifecycle (the part that's easy to break)

1. A transport handler calls `engine.kickOffTurn(io, chatId, userId, prompt, opts?)` (in `core/turnEngine.ts`), which **enqueues** the turn onto a per-chat tail Promise (`turnTailsMap: Map<string, Promise<void>>`) and returns immediately — explicitly **not** awaited. **This is load-bearing for Telegraf.** Telegraf serializes update processing per handler; if a turn awaits inside the handler, the bot stops fetching new updates, including the very `callback_query` clicks (Allow/Deny, AskUserQuestion answers) that would unblock the turn. Deadlock. Slack Bolt has its own concurrency model but the same fire-and-forget pattern keeps everything consistent.
2. Turns for the same chat run **serially**, oldest-first. A new message that arrives mid-turn waits for the current turn (and any already-queued ones) to finish. Different chats run in parallel. Cron fires (via the `Transport → kickOffTurnFromCron` registry in `scheduler/transport.ts`) feed the same queue, so a cron can never preempt an interactive turn. The only paths that abort the in-flight turn are `/new` and `/cancel`, both via the `engine.abortTurn` helper. `/new` aborts + clears `sessionId`; `/cancel` only aborts (session preserved). The queue itself is **not** drained by either command — already-typed messages still run, just in the post-abort session state.
3. `askClaude` runs the SDK `query` loop. Tool calls hit `canUseTool` (in `handlers/toolApprovals.ts`), which:
   - Auto-handles `AskUserQuestion` via `questions.ask` — never prompts for permission.
   - Short-circuits via `allowAlwaysTools` / `denyAlwaysTools`.
   - Otherwise sends a `TurnIO.reply` with the `Allow / Always / Deny / Never` `ButtonGrid` and `await`s an `approvals.register` promise that the transport's `actions.ts` later settles by calling into `handlers/clickRouter.ts → dispatchApprovalClick`.
4. Reply text is split via `chunk()` (3500-char soft cap, prefer newline boundaries) and sent as one or more messages through `TurnIO.reply`.
5. `onSessionId` persists the SDK session id the moment the `system/init` message arrives — so even if the user kills the bot mid-turn, the next message can resume the same Claude session.

### Budgets

Two independent ceilings, both optional and both off by default:

- **Monthly cap** — enforced by `core/budget.ts` against a per-chat month bucket (`ChatState.monthKey` + `monthUsd`), which rolls in the *user's* timezone. Checked in `runTurn` **after** the queue dequeues (a turn that waited behind others must be judged on current spend, not on spend at enqueue time) and again before each task run. At 80% the chat gets a one-shot warning (`budgetWarnedPct`, so it fires once per month); at 100% turns are refused with the cap named. Scope follows the usual rule: `/budget monthly` writes the chat layer in groups, the user layer in DMs.
- **Per-turn cap** — passed straight to the SDK as `maxBudgetUsd`, so a runaway turn stops itself mid-flight rather than being caught afterwards. User-level only. `budget.check()` returns `turnCapUsd` already clamped to whatever is left of the monthly cap.

`recordSpend` owns only the month bucket; callers keep doing their own `totalCostUsd` write. Task spend is billed to the task row *and* rolled into the chat total, so moving work into `/bg` can't dodge a cap.

### Trust policy

`handlers/trustPolicy.ts` replaced the old exact-tool-name `allowAlwaysTools` check. A rule is `Tool` (any input — exactly the legacy meaning) or `Tool(glob)`, where the glob is matched against **one canonical string per tool** defined by the `CANON` table: the command for `Bash`/`PowerShell`, the workspace-relative path for `Write`/`Edit`/`Read`, the host for `WebFetch`, serialized input for anything else. **That table is the security boundary** — if a tool's canonical string misses the part of the input that matters, a rule that looks narrow is actually wide.

- Order is **deny → allow → grant → prompt**. Deny always wins, so a standing `deny Bash(git push *)` survives both a later allow and an active grant.
- Path globs: `*` stops at `/`, `**` crosses it. A *relative* pattern never matches an absolute path outside the workspace — reaching out must be spelled `Write(C:/tmp/**)`. (This was a real bug caught by the tests: `Write(**)` originally matched `C:\Windows\...`.)
- `/trust grant 30m` is a time-boxed "allow everything", checked against wall clock at evaluation time and never cached for a turn. Task-scoped grants don't leak between tasks.
- Legacy `allowAlwaysTools` / `denyAlwaysTools` migrate at **read** time via `store.deriveTrustRules()` (non-destructive) and are folded into `trustRules` on the next rule write.
- The approval prompt offers **Always** (bare tool, historical meaning) *and* **Always &lt;pattern&gt;** when `proposePattern` has a useful narrowing (`npm run *`, `src/handlers/*`). The scoped button is a distinct callback scope (`perm:allow:pattern:<id>`) because Telegram caps `callback_data` at 64 bytes — the pattern is recomputed by the resolver from the pending input rather than carried in the id.

**Where the gate actually sits.** `canUseTool` is not consulted for calls Claude Code itself considers safe — `Read`/`Grep`/`Glob` always, and under `acceptEdits` (or a user-level `permissions.defaultMode: "auto"`) that extends to file edits and even a local `rm`. Verified: `git push` and `WebFetch` reach the callback; `echo`, `git log`, and `rm` under `acceptEdits` do not. So trust rules govern consequential/remote operations, while local mutations are governed by the permission mode. That is why worktree isolation matters, and why an in-place task forces `permissionMode: "default"` (below).

### Background tasks

`/bg <prompt>` creates a row in `data/tasks.json` and runs it through `core/taskRunner.ts`, **off** the per-chat queue, so the conversation stays live. `/tasks`, `/task <id>`, `/kill <id>`; the completion report carries `[Diff] [Merge] [Discard]` buttons.

Deliberately a separate runner rather than a branch inside `runTurn`: nearly every step differs (no streaming reply, no voice, no `lastPrompt`, different cwd, escalation instead of blocking approval). The shared pieces — `askClaude`, `buildCanUseTool`, `budget`, the MCP servers — are imported, not copied.

Four properties to preserve when editing it:

1. **Tasks never acquire the `.busy` sentinel.** Holding it would block every dev reload for the life of the task. Instead a task is checkpointed by its `sessionId` (persisted from `onSessionId`), aborted on shutdown, marked `interrupted` by `markInterruptedOnBoot()`, and offered a Resume button on the next boot. This is also why tasks are excluded from the 30-minute shutdown drain.
2. **Escalation, not blocking.** A tool that lands on `prompt` calls `CanUseToolOptions.onEscalate`, which records `pausedOn`, posts an Allow/Give-up prompt, and returns *deny* with an explanation. The turn ends, the slot frees, and tapping Allow adds the tool to the task's `taskAllowTools` and resumes the session. A paused task gives up after 24h (the sweeper, every 5 min).
3. **Worktrees.** `services/worktree.ts` puts each task on `task/<id>` in `<repo>/.worktrees/task-<id>`, forked from current HEAD. Concurrent tasks can't collide, output is a reviewable branch, and — specific to this repo — `scripts/dev.mjs` watches only `<repo>/src`, so a task editing the bot's own source doesn't trigger a reload mid-run. `.worktrees/` is added to `.git/info/exclude` (not the tracked `.gitignore`) on first use; `isDirty()` filters it out anyway, because an un-ignored `.worktrees/` makes the parent tree look permanently dirty and blocked every merge before that fix.
4. **Non-git workspaces run in place with `permissionMode: "default"`.** No worktree means nothing contains a mistake, so the chat's `acceptEdits`/`bypassPermissions` is deliberately *not* inherited there (verified: `default` gates a destructive `rm` that `acceptEdits` waves through). In-place tasks are also serialized one-per-workspace.

Concurrency: global cap `min(4, cpus-2)`, per-user cap `maxConcurrentTasks` (default 2). `resumeTask` pushes onto the queue even when the task is still winding down — approving a paused tool almost always happens before the previous run has exited, and an early return there silently dropped the resume.

### Watchers

`/watch add <kind> [target] -- <prompt>` fires a **background task** when something changes: a new commit (`git`), a touched path (`fs`), a changed response body or status (`http`), or a matching line appended to a log (`log`). Firing creates a task rather than a bare turn, so watcher work inherits worktree isolation, budgets, progress reporting and escalation for free.

- Idempotency is a fingerprint comparison (`lastKey`), the same restart-safe trick `lastFiredAt` plays for crons — there's no event queue to lose.
- **The first check only records a baseline.** Otherwise every new watcher immediately reacts to whatever already existed, which is the same reason the cron ticker ignores slots older than `createdAt`.
- `log` tracks a byte `cursor` so only appended data is scanned (a 2 GB log costs nothing per tick) and old matches never re-fire; a shrunken file is treated as rotation and resets.
- If the previous fire's task is still active, the round is skipped rather than stacking tasks.
- Source errors are announced on the first failure and then only every 20th tick, so a watcher pointed at a dead URL doesn't spam the chat.

### Cross-session context

Every workspace's Claude Code transcripts live together in `~/.claude/projects/<slug>/`, where the slug is the workspace path with `\`, `/` and `:` replaced by `-` (`D:\claudebot` → `D--claudebot`). The bot and the CLI write the same files, which is what makes both of these work.

**Switching by pasting an id.** A message whose entire body is a session id — full UUID, or an 8+ char hex prefix like the ones `/resume` prints — switches the chat's live session and never reaches Claude. `handlers/sessionSwitch.ts` owns it; both transports call `maybeSwitchSession` just before `kickOffTurn` and bail if it returns `true`. The detection is deliberately narrow, because a false positive would swallow a real prompt:

- Full UUID → always consumed. A bare UUID is never a real prompt, so an unknown one gets a "not in this workspace" reply rather than being forwarded.
- Hex prefix → consumed only if it resolves to a transcript **on disk** (or ambiguously to several). Anything else falls through untouched, so `deadbeef` or `abcdef12 is the commit…` still reaches Claude. This is why `findExistingSession` exists alongside the older `findSessionByPrefix`, which accepts full UUIDs it can't see (cross-machine `/resume`).

The confirmation echoes the target's age/size/first prompt and the *previous* id, so switching back is another paste. `/resume <id>` still works and is the only way to point at a session that isn't on this disk.

**Peeking into another session.** `session_ask` (in `services/sessionsMcp.ts`) resumes a past session with `forkSession: true` and asks it a question. The fork is the whole point: plain `resume` would append the exchange to that session's transcript, whereas forking branches into a new session id, so the original is byte-identical afterwards and the live turn's own session is untouched. The sub-agent already holds that conversation's context, so it answers from memory instead of the caller re-deriving everything.

The sub-agent is read-only, enforced in three places: `tools: ["Read","Grep","Glob"]` removes every other built-in from its context (verified — it reports `No such tool available: Bash`), `canUseTool` denies anything that slips through anyway (user-scope MCP servers), and `settingSources: ["project"]` drops user/local settings so their `permissions.allow` rules can't pre-approve a tool behind that callback. Note that Read/Grep/Glob never reach `canUseTool` — Claude Code treats them as safe reads in `default` mode. Also capped at `maxTurns: 12` / `maxBudgetUsd: 1.5`, billed to the chat's `totalCostUsd`, and wired to the turn's abort signal so `/cancel` kills an in-flight peek.

Approval split in `buildCanUseTool`: `session_list` and `session_search` are auto-allowed (they only stat/read transcripts — see `SESSIONS_READONLY_TOOLS`), while `session_ask` goes through the normal Allow/Deny prompt because it spends money. That also means a cron-fired turn can't peek unless `session_ask` is in `allowAlwaysTools`.

`askClaude` grew the options this needs — `forkSession`, `tools`, `allowedTools`, `settingSources`, `maxTurns`, `maxBudgetUsd` — all optional, all absent from the main turn path. Don't pass bare tool names in `allowedTools`: the SDK auto-approves them *before* `canUseTool` runs and warns about the shadowing.

### Scheduler (cron jobs)

Claude can schedule recurring prompts via the per-turn `mcp__scheduler__cron_create` / `cron_list` / `cron_update` / `cron_delete` tools. State lives in `data/crons.json`; the ticker (`scheduler/ticker.ts`) polls every 60s.

- **Edits go through `cron_update`, not delete-and-recreate.** `cron_update` patches any subset of `cron` / `prompt` / `resume` / `oneShot` / `description` / `enabled` on an existing id, so the job keeps the id the user knows and the prompt doesn't have to be restated. Two details it owns: (a) `cron_list` truncates prompts to `PROMPT_PREVIEW_CHARS` (400) in the all-crons listing, so `cron_list` takes an optional `id` that returns one row with the prompt in full — that's the read you need before rewriting a prompt; (b) changing the expression pins `lastFiredAt` to just under the current minute, because `createdAt` doesn't move on an update and the ticker's "ignore slots older than `createdAt`" guard would otherwise let the new expression's most recent past slot fire instantly with a bogus "ran N min late — bot was offline" prefix. `systemTask` rows (the seeded SDK-update cron) accept only `cron` and `enabled`: `prompt`/`resume` are dead fields there, and `description` is the marker `seedDefaultCronsIfMissing` matches on, so renaming it would make the seeder mint a duplicate.
- **`mcp__scheduler__*` tools auto-allow.** `buildCanUseTool` short-circuits any tool whose name starts with `mcp__scheduler__` — no Allow/Deny prompt — because they only mutate `data/crons.json`. The actual prompt that fires later still goes through normal approvals.
- **Cron-fired turns auto-deny non-allow-always tools.** `runTurn` is called with `triggerSource: "cron"`; `buildCanUseTool` rejects anything not in `state.allowAlwaysTools` instead of sending an inline-button approval that nobody is awake to click. To make a cron useful, send the prompt interactively first and tap **Always** on each tool the cron will need (or use `/rules`).
- **Cron-fired turns also auto-deny `AskUserQuestion`** — there's no human reader. The prompt should already contain everything Claude needs.
- **Fresh session per fire by default.** `cron_create` defaults `resume: false`, meaning the fire doesn't carry conversational baggage from the chat's interactive Claude session — and the new sessionId is NOT persisted back into `state.sessionId`, so interactive use stays isolated. Pass `resume: true` for "continue our work every Monday" jobs.
- **One-shot reminders.** Pass `oneShot: true` to `cron_create` for "remind me Sunday at 10" — the ticker deletes the row right after dispatching so a date-specific expression like `0 10 3 5 *` doesn't fire every year. If the slot is missed past the catch-up window, the one-shot is dropped without firing instead of being left as a stale row.
- **Calendar mirroring + config self-edit guidance.** Every turn appends the result of `buildSchedulerSystemGuidance(tz, userId, chatId)` (in `scheduler/mcp.ts`) to the Claude Code preset system prompt. It tells Claude (a) to mirror calendar-event reminders into a Google Calendar MCP if one is loaded for the turn — meetings, appointments, flights, birthdays… — while keeping data-pull crons (weather, news, periodic reports) cron-only; (b) where the user's per-user config lives (`data/config.json` under `users.<userId>`) so Claude can edit it from a DM; and (c) in groups, that workspace/mode/model should be set per-chat via slash commands rather than by editing the user-layer key (which would clobber every other chat). Wiring the calendar MCP itself is out-of-band — `claude mcp add` user-scope so the SDK inherits it; the gateway doesn't bundle calendar credentials.
- **Catch-up window: 30 minutes.** If the bot was down through a slot, the ticker fires it on boot only if the slot was within the last 30 min, and prefixes the prompt with "⏰ ran Nm late — bot was offline." Older slots are recorded as fired (`lastFiredAt`) without dispatching, so they don't accumulate.
- **Idempotency.** `lastFiredAt` is the minute-bucketed timestamp of the slot. The ticker won't refire a slot it has already recorded, even across restarts.
- **TZ is per-user.** Resolved from `users.tzFor(c.userId)` for each cron row at every tick. Default `Asia/Jerusalem`; override per user via the `tz` field on the `users.<id>` block in `data/config.json`. The legacy `TZ=` env var is no longer read.
- **Shutdown order.** `cronTicker.stop()` runs before `gracefulShutdown` so no new fires start during the drain window. In-flight cron turns drain through the same `inFlightChats` mechanism as user turns.

### Graceful reload (tsx watch)

The orchestrator in `index.ts` is wired to SIGINT/SIGTERM. It writes a restart marker (each entry tagged with `transport`), tells in-flight chats "code change detected — bot will reload after this turn finishes" via the matching transport's `notifyChat`, then waits up to 30 minutes for `engine.turnTails()` to drain before stopping the transports. `tsx watch` waits for the old process to exit before spawning the new one, so a Claude turn that edits this bot's own source can finish cleanly.

**Single-instance lock.** On boot, before any state load, the process takes an exclusive lockfile at `data/.instance.lock` (`state/instanceLock.ts`) carrying `{ pid, startedAt, heartbeatAt, hostname, nodeVersion, transports }` and refreshes the heartbeat every 60s. A second process starting against the same `data/` dir refuses to boot with a formatted error pointing at the held pid; a stale lock (dead pid OR heartbeat older than 5 min) is cleared atomically via rename and re-acquired. If a running process detects another instance has stolen ownership during a heartbeat refresh, it `process.exit(1)`s rather than keep racing on the same Telegram/Slack tokens. The lock is released on graceful shutdown, on `uncaughtException` (which now exits), and via a `process.on("exit")` handler registered inside `acquire()`.

The transport heuristic in `index.ts` is `Number.isFinite(Number(chatId)) ? "telegram" : "slack"` — Telegram chat ids are integers (positive or negative for groups); Slack ids start with `C/D/G`. They never collide.

For changes to `data/config.json` (per-user defaults *or* per-chat state), there's no restart at all — the `store.watch()` fs.watch fires within ~200ms of the file changing, the new value enters the in-memory cache, and the next turn uses it. Edits made by Claude itself via Edit/Write are picked up the same way.

### Uploads

Photos are sent as base64 image blocks in the SDK `user` message (see `buildPrompt` in `claude.ts`). Non-image documents are written to `<workspace>/.uploads/<timestamp>-<sanitized-name>` and their relative path is included in the prompt — the user's caption (if any) is appended, and Claude is told to use `Read` on the path. 5 MB cap on images.

## Conventions and gotchas

- **`.ts` import extensions are mandatory** — TypeScript's `allowImportingTsExtensions` plus `tsx` runtime, no transpile step.
- **ESM-only** (`"type": "module"`). Use `node:` prefixes for builtins (`node:fs/promises`, `node:path`).
- **Strict mode + `noUncheckedIndexedAccess`** — array/object index access yields `T | undefined`. Existing code uses non-null `!` after a presence check (e.g. `q.options[oi]!`); follow the pattern.
- **Layering rule.** `core/` and `handlers/` must not import from `telegram/` or `slack/`. Each transport may import from `core/handlers` but not from the other transport. Shared bits go in `handlers/commandShared.ts` / `handlers/respondModes.ts`.
- **Telegraf handlers must return fast.** Handlers that need to do long work must `void`-dispatch a separate async function (see `engine.kickOffTurn`). The `handlerTimeout` default is 90 s.
- **Markdown replies have a fallback.** Telegram rejects malformed Markdown with HTTP 400. Wrap `ctx.reply(text, { parse_mode: "Markdown" })` in try/catch and resend with `text.replace(/[*_`]/g, "")` — see existing examples.
- **`safeAnswerCbQuery`** swallows the "query is too old" / "query ID is invalid" errors that Telegram returns when the bot answers a callback after a restart. Use it instead of `ctx.answerCbQuery` directly.
- **New callback prefixes need registering in three places.** A new button family (`task:*` was the last one) needs a `dispatch*Click` in `handlers/clickRouter.ts`, a prefix branch in `telegram/actions.ts`, **and** an addition to the `app.action(/^(?:perm|q|task):/)` regex in `slack/actions.ts`. Miss the Slack regex and those buttons silently no-op.
- **Telegram `callback_data` is capped at 64 bytes.** Don't put payloads in a callback id — carry a scope token and recompute (see the `perm:allow:pattern:*` handling in `handlers/toolApprovals.ts`).
- **A bare session id is a command, not a prompt.** `handlers/sessionSwitch.ts` intercepts it before `kickOffTurn`, so anything downstream (Claude included) never sees it. New text entry points need to call `maybeSwitchSession` too, or pasting an id there will silently start a Claude turn about a UUID.
- **The Claude session id is the resume key.** `state.sessionId` is what gets passed as `resume` on the next turn. Don't clear it on errors — only on `/new` or explicit `/resume reset`.
- **Auth is a hard wall.** The `bot.use` middleware drops every update whose `ctx.from.id` isn't in `config.allowedUserIds` (parsed from env). After auth passes, the middleware also calls `users.ensure(userId)` so a freshly-allowed user gets a default `users.<id>` block seeded from `userTemplate.json` inside `data/config.json` on their first message. New handlers don't need to re-check auth.
- **Layered behavior config.** Workspace / permissionMode / model resolve chat → user → default. Slash commands `/workspace` `/mode` `/model` `/cloudexpert` write to the chat layer in groups, the user layer in DMs (so each Telegram group gets its own persistent workspace without changing the user's other chats). `/rules` writes to ChatState because tool-trust is per-conversation. Voice and tz remain user-only.
- **`.worktrees/` is git-ignored and machine-local.** It holds background-task checkouts. Never commit it; never create a worktree inside another one (`worktree.isInsideWorktree` guards this).
- **`data/` and `workspace/` are git-ignored.** The session store, turn log, restart marker, per-user app configs, and Claude's default working directory all live under those paths; never commit them.
- **`/cloudexpert` is a personal shortcut** that hard-codes `D:\cloudexpert` as the workspace. Keep it (or generalize) — don't be surprised by a Windows path in source.
- **The bot never edits `.env`.** Personal/auth info (bot token, allowlist, oauth) stays in env. App behavior lives in `data/config.json` (under `users.<id>` for per-user defaults, `sessions.<chatId>` for per-chat state) — that's the file Claude is told to edit when the user asks for a config change.

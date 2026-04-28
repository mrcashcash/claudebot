# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Telegram → Claude Code gateway. The Node.js process runs a Telegraf bot whose handlers feed each incoming message to `@anthropic-ai/claude-agent-sdk`'s `query()`, then stream Claude's response back to the chat. Tool calls Claude wants to make are routed through Telegram inline buttons (Allow / Always / Deny / Never) before they execute. There is no web UI; the bot itself is the only interface.

## Commands

```bash
npm run dev        # tsx watch — auto-reloads on src/ changes (preferred for development)
npm start          # one-shot run via tsx
npm run typecheck  # tsc --noEmit; the only "build" check (project is noEmit)
```

There are no tests, no linter, and no build artifacts. `tsx` runs `.ts` directly; `tsconfig.json` has `noEmit: true` and `allowImportingTsExtensions: true`, so all relative imports use the explicit `.ts` extension (`./bot.ts`, not `./bot`). Keep that convention when adding files.

Required env (see `.env.example`): `TELEGRAM_BOT_TOKEN`, `ALLOWED_TELEGRAM_USER_IDS` (comma-separated numeric Telegram user IDs — anything else is silently dropped by the auth middleware in `bot.ts`). Optional: `CLAUDE_CODE_OAUTH_TOKEN` (otherwise the SDK reuses `~/.claude/.credentials.json`).

Per-user app behavior (workspace, permission mode, model, voice, tz) lives in `data/users/<telegram-user-id>.json` — auto-created from `userTemplate.json` on each authorized user's first message and reloaded on the next turn whenever the file changes (fs.watch with ~200ms debounce). Workspace / permissionMode / model can additionally be overridden **per chat** via the chat-layer in `data/sessions.json` so each Telegram group remembers its own settings independently of the user's other chats; the `/workspace` `/mode` `/model` `/cloudexpert` slash commands write to the chat layer in groups and the user layer in DMs. Deleting a user's JSON file does NOT revoke their access — auth is gated by `ALLOWED_TELEGRAM_USER_IDS`. The bot never edits `.env`.

## Architecture

Module map (everything lives in `src/`):

- `index.ts` — entrypoint. Loads config, hydrates the session and user-config stores, starts the user-config fs.watch, builds the bot, prints a restart-completed message to chats that were mid-turn before the last reload, then calls `bot.launch`.
- `config.ts` — env parsing. `loadConfig()` returns the minimal `Config` shape: `telegramBotToken`, `allowedUserIds`, `gatewayDir`. Everything else moved to per-user JSON.
- `configValidate.ts` — pure validators (`parsePermissionMode`, `parseWhisperModel`, …) plus `validateUserConfig`, shared between `config.ts` and `state/users.ts`.
- `bot.ts` — Telegraf wiring: command handlers (`/help`, `/status`, `/model`, `/mode`, `/workspace`, `/cloudexpert`, `/init`, `/compact`, `/resume`, `/new`, `/cost`, `/rules`, `/cron`), message handlers (text / photo / document), the `callback_query` router, and `runTurn` / `gracefulShutdown` / `kickOffTurnFromCron`. **This is the file you'll touch most.**
- `claude.ts` — wraps the Agent SDK. `askClaude()` calls `query()`, accumulates assistant text, captures `session_id` and `total_cost_usd` from the `result` message, and forwards `PreToolUse` / `PostToolUse` / `PostToolUseFailure` hooks to `turnLog`. Throws `AskClaudeAbortedError` on signal abort.
- `state/store.ts` — owns `data/config.json` (the single consolidated JSON for both per-user and per-chat state) and is the only module that does file I/O for that file. `load()` reads `config.json`; missing file → empty cfg, populated as the first user/chat appears. Schema: `{ users: { "<userId>": UserConfig }, sessions: { "<chatId>": ChatState } }`. Atomic `tmp + rename` writes; `lastSelfWriteMs` lets the file watcher ignore its own echo. `watch()` starts a single 200ms-debounced `fs.watch` that re-reads the file on external edits and mutates the cached objects in place so existing references stay valid. `crons.json` is intentionally **not** consolidated — it stays at `data/crons.json`.
- `state/sessions.ts` — thin wrapper over `store.ts`. `get(chatId)` / `update(chatId, patch)` operate on `store.getSessions()`. State carried: `sessionId`, `totalCostUsd`, `allowAlwaysTools[]`, `denyAlwaysTools[]`, plus the optional per-chat overrides `workspaceDir` / `permissionMode` / `model` (set in groups so each group has its own persistent workspace; falls through to the user layer when unset).
- `state/users.ts` — thin wrapper over `store.ts`. Holds `workspaceDir`, `permissionMode`, `model`, `voice` (Partial<VoiceConfig>), `tz`, `name`, `notes` per user. `ensure(userId)` reads `userTemplate.json`, validates it, and seeds `users.<userId>` for first-time users. `watch()` / `stopWatch()` delegate to `store.watch()`. Helpers `effectiveWorkspace(chatId, userId, gatewayDir)`, `effectiveMode(chatId, userId)`, `effectiveModel(chatId, userId)` consult the chat-layer override first then fall through to the user layer; `voiceFor(userId)` and `tzFor(userId)` are user-only (those settings don't make sense per-chat).
- `handlers/approvals.ts` — in-memory map of `tool_use_id → resolver` for pending Allow/Deny prompts.
- `handlers/questions.ts` — handles the SDK's built-in `AskUserQuestion` tool. Renders one question at a time as inline-keyboard messages, supports single- and multi-select, and resolves with `{ [question]: answerLabel }`.
- `state/turnLog.ts` — append-only `data/turns.jsonl` of pre/post tool events (fields trimmed to 4 KB). Useful for debugging what Claude actually did.
- `state/logger.ts` — diagnostic JSON logger. One combined daily file at `data/logs/YYYY-MM-DD.jsonl`. Every record carries `category` (one of `error` / `turn` / `approval` / `cron` / `lifecycle`), `event` (dot-namespaced like `turn.start`, `approval.decision`, `cron.fired`), `ts`, `level`, plus event-specific fields. Boot calls `sweepOldLogs(30)` to delete files older than 30 days. Writes are fire-and-forget; if logging itself fails the caller is unaffected. To investigate after the fact: `cat data/logs/<date>.jsonl | jq 'select(.category=="error")'`.
- `state/restart-marker.ts` — `data/restart-marker.json` written on graceful shutdown so the next process can post a "✅ Bot reloaded" notice to the chats whose turn was in flight.
- `state/crons.ts` — atomic JSON store at `data/crons.json` keyed by cron id. Mirrors `sessions.ts`. Carries `chatId`, `userId` (whose user config drives TZ + workspace at fire time), `cron` (5-field), `prompt`, `enabled`, `resume`, `lastFiredAt` (minute bucket — the idempotency key), `description`. Rows missing `userId` are dropped on `load()`. Hydrate via `crons.load()` at boot.
- `scheduler/mcp.ts` — `buildSchedulerMcp(chatId, userId, tz)` returns an SDK MCP server (`createSdkMcpServer` + `tool`) exposing `cron_create` / `cron_list` / `cron_delete` to Claude. **A fresh server instance is built per turn in `bot.ts`**, closed over the current `chatId`/`userId`/tz, so Claude can never read or mutate another chat's jobs even if it guesses an id, and the row records who owns the cron. Cap is 20 crons per chat. `buildSchedulerSystemGuidance(tz, userId, chatId)` returns the per-turn system-prompt addendum (calendar mirroring guidance + "your config lives at data/users/<id>.json" pointer + group-vs-DM advice on whether to recommend slash commands or edit the user file directly).
- `scheduler/runner.ts` — `fire(c, lateMs)` builds the prompt (with an "⏰ ran Nm late" prefix if catching up) and calls `kickOffTurnFromCron(chatId, userId, prompt)`.
- `scheduler/ticker.ts` — single `setInterval(60s)` that finds due jobs via `cron-parser` (TZ resolved per row via `users.tzFor(c.userId)`, default `Asia/Jerusalem`), reserves the slot by writing `lastFiredAt`, then fires. Catch-up window is 30 minutes — if the bot was offline through a slot longer than that, the slot is recorded but skipped.
- `handlers/turnIO.ts` — `TurnIO` interface (`chatId`, `reply`, `sendChatAction`, `telegram`). Telegraf handlers build it from `ctx` via `ioFromContext`; the cron runner builds it from `bot.telegram` via `ioFromTelegram`. This is what lets `runTurn` / `buildCanUseTool` / `questions.ask` work without a Telegraf `Context`.
- `handlers/cronCommands.ts` — `/cron list|pause|resume|delete` (creation stays Claude-driven via the MCP tool).

### Per-user / per-chat state model

Two stores, layered for the three "behavior" settings (workspace / permissionMode / model):

- **Per-user app config** (`state/users.ts`, JSON path `data/config.json#users.<userId>`) — workspace, permission mode, model, voice settings, tz, name, notes. The user-level *default*: applies to DMs and to any group that hasn't set its own override. Editable by hand, by Claude (Edit/Write `data/config.json`), or by the slash commands when used from a DM. Auto-reloaded via the `store.watch()` fs.watch.
- **Per-chat runtime state** (`state/sessions.ts`, JSON path `data/config.json#sessions.<chatId>`) — active Claude `sessionId`, cumulative `totalCostUsd`, per-tool `allowAlwaysTools[]` / `denyAlwaysTools[]`, plus optional per-chat overrides for `workspaceDir` / `permissionMode` / `model`. The override layer is what lets the user have a different workspace per Telegram group. The slash commands `/workspace` `/mode` `/model` `/cloudexpert` write to the chat layer in groups (where `chat.type !== "private"`) and to the user layer in DMs.

Both layers live in the **same** file, `data/config.json` — that's the only file you need to copy between machines to reproduce behavior.

Resolvers `users.effectiveWorkspace(chatId, userId, gatewayDir)`, `users.effectiveMode(chatId, userId)`, `users.effectiveModel(chatId, userId)` consult chat → user → default. Always use them instead of reading fields directly. `users.tzFor(userId)` and `users.voiceFor(userId)` stay user-only — those settings don't sensibly differ per-chat.

Note: external edits to `data/config.json` (whether from Claude in a turn or a hand-edit) are picked up by the watcher on the next turn for both layers. The bot still does its own writes, so a Claude edit racing a `sessions.update()` could be clobbered — for chat-layer changes prefer the slash commands; for user-layer defaults, hand-edit / Claude-edit is fine.

`MODEL_ALIASES` maps friendly names (`opus` / `sonnet` / `haiku` / `default`) to SDK model IDs. `default` resolves to empty string, meaning "let the SDK pick."

### Turn lifecycle (the part that's easy to break)

1. A handler calls `kickOffTurn(ctx, chatId, prompt)`, which **enqueues** the turn onto a per-chat tail Promise (`turnTails: Map<number, Promise<void>>` in `bot.ts`) and returns immediately — explicitly **not** awaited. **This is load-bearing.** Telegraf serializes update processing per handler; if a turn awaits inside the handler, the bot stops fetching new updates, including the very `callback_query` clicks (Allow/Deny, AskUserQuestion answers) that would unblock the turn. Deadlock. Always dispatch turns through the queue, never inline-await.
2. Turns for the same chat run **serially**, oldest-first. A new message that arrives mid-turn waits for the current turn (and any already-queued ones) to finish. Different chats run in parallel. Cron fires (`kickOffTurnFromCron`) feed the same queue, so a cron can never preempt an interactive turn. The only paths that abort the in-flight turn are `/new` and `/cancel`, both via the `abortTurn` helper passed into `registerCommands`. `/new` aborts + clears `sessionId`; `/cancel` only aborts (session preserved). The queue itself is **not** drained by either command — already-typed messages still run, just in the post-abort session state.
3. `askClaude` runs the SDK `query` loop. Tool calls hit `canUseTool` (in `bot.ts`), which:
   - Auto-handles `AskUserQuestion` via `questions.ask` — never prompts for permission.
   - Short-circuits via `allowAlwaysTools` / `denyAlwaysTools`.
   - Otherwise sends a Telegram message with `permissionKeyboard(toolUseId)` and `await`s an `approvals.register` promise that the `callback_query` handler later settles.
4. Reply text is split via `chunk()` (3500-char soft cap, prefer newline boundaries) and sent as one or more messages.
5. `onSessionId` persists the SDK session id the moment the `system/init` message arrives — so even if the user kills the bot mid-turn, the next message can resume the same Claude session.

### Scheduler (cron jobs)

Claude can schedule recurring prompts via the per-turn `mcp__scheduler__cron_create` / `cron_list` / `cron_delete` tools. State lives in `data/crons.json`; the ticker (`scheduler/ticker.ts`) polls every 60s.

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

`gracefulShutdown` is wired to SIGINT/SIGTERM. It writes a restart marker, tells in-flight chats "code change detected — bot will reload after this turn finishes," then waits up to 30 minutes for `inFlightChats` to drain before stopping the bot. `tsx watch` waits for the old process to exit before spawning the new one, so a Claude turn that edits this bot's own source can finish cleanly.

For changes to `data/config.json` (per-user defaults *or* per-chat state), there's no restart at all — the `store.watch()` fs.watch fires within ~200ms of the file changing, the new value enters the in-memory cache, and the next turn uses it. Edits made by Claude itself via Edit/Write are picked up the same way.

### Uploads

Photos are sent as base64 image blocks in the SDK `user` message (see `buildPrompt` in `claude.ts`). Non-image documents are written to `<workspace>/.uploads/<timestamp>-<sanitized-name>` and their relative path is included in the prompt — the user's caption (if any) is appended, and Claude is told to use `Read` on the path. 5 MB cap on images.

## Conventions and gotchas

- **`.ts` import extensions are mandatory** — TypeScript's `allowImportingTsExtensions` plus `tsx` runtime, no transpile step.
- **ESM-only** (`"type": "module"`). Use `node:` prefixes for builtins (`node:fs/promises`, `node:path`).
- **Strict mode + `noUncheckedIndexedAccess`** — array/object index access yields `T | undefined`. Existing code uses non-null `!` after a presence check (e.g. `q.options[oi]!`); follow the pattern.
- **Telegraf handlers must return fast.** Handlers that need to do long work must `void`-dispatch a separate async function (see `kickOffTurn`). The `handlerTimeout` default is 90 s.
- **Markdown replies have a fallback.** Telegram rejects malformed Markdown with HTTP 400. Wrap `ctx.reply(text, { parse_mode: "Markdown" })` in try/catch and resend with `text.replace(/[*_`]/g, "")` — see existing examples.
- **`safeAnswerCbQuery`** swallows the "query is too old" / "query ID is invalid" errors that Telegram returns when the bot answers a callback after a restart. Use it instead of `ctx.answerCbQuery` directly.
- **The Claude session id is the resume key.** `state.sessionId` is what gets passed as `resume` on the next turn. Don't clear it on errors — only on `/new` or explicit `/resume reset`.
- **Auth is a hard wall.** The `bot.use` middleware drops every update whose `ctx.from.id` isn't in `config.allowedUserIds` (parsed from env). After auth passes, the middleware also calls `users.ensure(userId)` so a freshly-allowed user gets a default `users.<id>` block seeded from `userTemplate.json` inside `data/config.json` on their first message. New handlers don't need to re-check auth.
- **Layered behavior config.** Workspace / permissionMode / model resolve chat → user → default. Slash commands `/workspace` `/mode` `/model` `/cloudexpert` write to the chat layer in groups, the user layer in DMs (so each Telegram group gets its own persistent workspace without changing the user's other chats). `/rules` writes to ChatState because tool-trust is per-conversation. Voice and tz remain user-only.
- **`data/` and `workspace/` are git-ignored.** The session store, turn log, restart marker, per-user app configs, and Claude's default working directory all live under those paths; never commit them.
- **`/cloudexpert` is a personal shortcut** that hard-codes `D:\cloudexpert` as the workspace. Keep it (or generalize) — don't be surprised by a Windows path in source.
- **The bot never edits `.env`.** Personal/auth info (bot token, allowlist, oauth) stays in env. App behavior lives in `data/config.json` (under `users.<id>` for per-user defaults, `sessions.<chatId>` for per-chat state) — that's the file Claude is told to edit when the user asks for a config change.

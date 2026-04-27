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

Required env (see `.env.example`): `TELEGRAM_BOT_TOKEN`, `ALLOWED_TELEGRAM_USER_IDS` (comma-separated numeric Telegram user IDs — anything else is silently dropped by the auth middleware in `bot.ts`). Optional: `CLAUDE_WORKSPACE_DIR`, `CLAUDE_PERMISSION_MODE` (`default` | `acceptEdits` | `bypassPermissions` | `plan`), `CLAUDE_CODE_OAUTH_TOKEN` (otherwise the SDK reuses `~/.claude/.credentials.json`).

## Architecture

Module map (everything lives in `src/`):

- `index.ts` — entrypoint. Loads config, hydrates the session store, builds the bot, prints a restart-completed message to chats that were mid-turn before the last reload, then calls `bot.launch`.
- `config.ts` — env parsing. `loadConfig()` is the single source of truth for `Config`.
- `bot.ts` — Telegraf wiring: command handlers (`/help`, `/status`, `/model`, `/mode`, `/workspace`, `/cloudexpert`, `/init`, `/compact`, `/resume`, `/clear` (+ `/reset`/`/new`), `/cost`, `/rules`), message handlers (text / photo / document), the `callback_query` router, and `runTurn` / `gracefulShutdown`. **This is the file you'll touch most.**
- `claude.ts` — wraps the Agent SDK. `askClaude()` calls `query()`, accumulates assistant text, captures `session_id` and `total_cost_usd` from the `result` message, and forwards `PreToolUse` / `PostToolUse` / `PostToolUseFailure` hooks to `turnLog`. Throws `AskClaudeAbortedError` on signal abort.
- `sessions.ts` — atomic JSON store at `data/sessions.json` keyed by Telegram chat id. Writes via `tmp + rename`. `load()` must be awaited at boot before any `get`/`update`. State carried: `sessionId`, `totalCostUsd`, `model`, `permissionMode`, `workspaceDir`, `allowAlwaysTools[]`, `denyAlwaysTools[]`.
- `approvals.ts` — in-memory map of `tool_use_id → resolver` for pending Allow/Deny prompts.
- `questions.ts` — handles the SDK's built-in `AskUserQuestion` tool. Renders one question at a time as inline-keyboard messages, supports single- and multi-select, and resolves with `{ [question]: answerLabel }`.
- `turnLog.ts` — append-only `data/turns.jsonl` of pre/post tool events (fields trimmed to 4 KB). Useful for debugging what Claude actually did.
- `restart-marker.ts` — `data/restart-marker.json` written on graceful shutdown so the next process can post a "✅ Bot reloaded" notice to the chats whose turn was in flight.

### Per-chat state model

Each Telegram chat is independent. `Config` holds defaults; `ChatState` holds optional overrides for `workspaceDir`, `permissionMode`, `model`, plus the active Claude `sessionId` and per-tool always-allow/deny rules. The helpers `effectiveWorkspace(state)` and `effectiveMode(state)` (in `bot.ts`) collapse override-or-default — use them rather than reading either field directly.

`MODEL_ALIASES` maps friendly names (`opus` / `sonnet` / `haiku` / `default`) to SDK model IDs. `default` resolves to empty string, meaning "let the SDK pick."

### Turn lifecycle (the part that's easy to break)

1. A handler calls `kickOffTurn(ctx, chatId, prompt)`, which fires `runTurn` as **`void runTurn(...)`** — explicitly **not** awaited. **This is load-bearing.** Telegraf serializes update processing per handler; if a turn awaits inside the handler, the bot stops fetching new updates, including the very `callback_query` clicks (Allow/Deny, AskUserQuestion answers) that would unblock the turn. Deadlock. Always dispatch turns fire-and-forget.
2. `runTurn` aborts any prior in-flight turn for the same chat (newest message wins) and creates a fresh `AbortController`.
3. `askClaude` runs the SDK `query` loop. Tool calls hit `canUseTool` (in `bot.ts`), which:
   - Auto-handles `AskUserQuestion` via `questions.ask` — never prompts for permission.
   - Short-circuits via `allowAlwaysTools` / `denyAlwaysTools`.
   - Otherwise sends a Telegram message with `permissionKeyboard(toolUseId)` and `await`s an `approvals.register` promise that the `callback_query` handler later settles.
4. Reply text is split via `chunk()` (3500-char soft cap, prefer newline boundaries) and sent as one or more messages.
5. `onSessionId` persists the SDK session id the moment the `system/init` message arrives — so even if the user kills the bot mid-turn, the next message can resume the same Claude session.

### Graceful reload (tsx watch)

`gracefulShutdown` is wired to SIGINT/SIGTERM. It writes a restart marker, tells in-flight chats "code change detected — bot will reload after this turn finishes," then waits up to 30 minutes for `inFlightChats` to drain before stopping the bot. `tsx watch` waits for the old process to exit before spawning the new one, so a Claude turn that edits this bot's own source can finish cleanly. If the workspace equals the gateway dir, `index.ts` warns about this on boot.

### Uploads

Photos are sent as base64 image blocks in the SDK `user` message (see `buildPrompt` in `claude.ts`). Non-image documents are written to `<workspace>/.uploads/<timestamp>-<sanitized-name>` and their relative path is included in the prompt — the user's caption (if any) is appended, and Claude is told to use `Read` on the path. 5 MB cap on images.

## Conventions and gotchas

- **`.ts` import extensions are mandatory** — TypeScript's `allowImportingTsExtensions` plus `tsx` runtime, no transpile step.
- **ESM-only** (`"type": "module"`). Use `node:` prefixes for builtins (`node:fs/promises`, `node:path`).
- **Strict mode + `noUncheckedIndexedAccess`** — array/object index access yields `T | undefined`. Existing code uses non-null `!` after a presence check (e.g. `q.options[oi]!`); follow the pattern.
- **Telegraf handlers must return fast.** Handlers that need to do long work must `void`-dispatch a separate async function (see `kickOffTurn`). The `handlerTimeout` default is 90 s.
- **Markdown replies have a fallback.** Telegram rejects malformed Markdown with HTTP 400. Wrap `ctx.reply(text, { parse_mode: "Markdown" })` in try/catch and resend with `text.replace(/[*_`]/g, "")` — see existing examples.
- **`safeAnswerCbQuery`** swallows the "query is too old" / "query ID is invalid" errors that Telegram returns when the bot answers a callback after a restart. Use it instead of `ctx.answerCbQuery` directly.
- **The Claude session id is the resume key.** `state.sessionId` is what gets passed as `resume` on the next turn. Don't clear it on errors — only on `/clear`, `/reset`, `/new`, or explicit `/resume reset`.
- **Auth is a hard wall.** The `bot.use` middleware drops every update whose `ctx.from.id` isn't in `config.allowedUserIds`. New handlers don't need to re-check.
- **`data/` and `workspace/` are git-ignored.** The session store, turn log, restart marker, and Claude's default working directory all live under those paths; never commit them.
- **`/cloudexpert` is a personal shortcut** that hard-codes `D:\cloudexpert` as the workspace. Keep it (or generalize) — don't be surprised by a Windows path in source.

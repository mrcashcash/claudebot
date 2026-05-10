# Feature Request: Share Claude Code sessions between host CLI and Telegram bot

## Problem

Today, a Claude Code session started in the host CLI (or VS Code / desktop app) and a session driven through the Telegram bot are completely separate runtimes, even when both point at the same workspace directory.

What does cross over between them:

- The workspace files on disk (git state, edits)
- Auto-memory under `~/.claude/projects/<slug>/memory/`
- `CLAUDE.md` and other on-disk instructions

What does **not** cross over:

- The live conversation transcript / message history
- Todos, plan state, pending tool approvals
- Any in-memory state the model is holding for the current task

So if I'm mid-task on the desktop and want to keep going from my phone via Telegram, I have to either:

1. Ask the host session to dump state into a memory file or scratch note, then have the Telegram session read it back, or
2. Re-prompt from scratch in Telegram and lose the working context.

Both are friction. The first one also pollutes auto-memory with ephemeral handoff notes that don't really belong there.

## What I'd like

A way to **resume the same session** from a different runtime — specifically: continue a host CLI session from the Telegram bot (and ideally the reverse).

Concrete shapes this could take, roughly in order of how invasive they are:

### Option A — explicit handoff command

A slash command in either runtime that exports a handoff bundle:

- `/handoff` in host CLI → writes the current session ID + transcript pointer somewhere the bot can read (e.g. `data/handoffs/<chatId>.json` for the Telegram bot, or a per-user file under `~/.claude`).
- `/resume` in Telegram → loads the most recent handoff bundle for this user/workspace and continues from there.

This is the smallest change. It only works one-shot (one resume per handoff) but covers the main use case ("I started this on my desk, finishing on the couch").

### Option B — shared session store keyed by workspace + user

Both runtimes write transcripts to a common location keyed by `(userId, workspaceDir)` instead of by runtime. The Telegram bot already keys per `chatId` in `data/config.json` under `sessions.<chatId>`; that key could grow to also hold (or point at) the host CLI's session for the same workspace, with a "latest active" pointer.

`/resume` in Telegram would then default to the latest session for that workspace regardless of where it was last touched.

This is more invasive but makes the experience seamless: any device, same conversation.

### Option C — live mirroring

Both runtimes attach to the same session in real time, similar to how `tmux attach` works. Probably overkill for the actual need; listing it for completeness.

## Why option A is probably the right starting point

- No change to how transcripts are stored.
- No coupling between the host CLI's storage format and the bot's storage format.
- Trivially safe: a handoff is opt-in, one direction at a time, and the user explicitly chooses when to invoke it.
- Covers the dominant workflow ("continue this from my phone") without needing to solve the harder concurrency questions of option B/C (what happens if both sides type at once? whose tool approvals win?).

## Suggested ergonomics

- `/handoff` returns a short code or QR the user can paste/scan into Telegram, so they don't need to know paths.
- `/resume` with no argument resumes the most recent handoff for the current user + workspace.
- `/resume <code>` picks a specific one.
- Handoffs expire (e.g. 24h) so stale state doesn't accumulate.
- The resumed session shows a one-line banner identifying where it came from ("resumed from host CLI session started 2026-05-08 14:02").

## Out of scope / non-goals

- Cross-user handoffs. Always scoped to the same authenticated user.
- Sharing tool permission grants. The resuming runtime should re-prompt for tool approvals as if it were a fresh session in that runtime — its sandbox/permission model is its own.
- Mirroring secrets or `.env` content into the handoff bundle.

## Notes about the current bot setup (for the maintainer)

- Per-chat state already lives in `data/config.json` under `sessions.<chatId>`. A handoff inbox could live next to it (e.g. `data/handoffs/<userId>.json`) without changing the existing config schema.
- Workspace overrides happen at chat layer in groups, so a `/resume` in a group should default to the group's `workspaceDir`, not the user-layer one.
- Files up to ~100MB can already round-trip via `mcp__claudebot__send_file`; a handoff bundle would be tiny by comparison.

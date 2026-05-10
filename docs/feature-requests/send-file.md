# Send files from Claude back to the user via Telegram

## Problem

Claude can produce or have access to local files (build artifacts, reports,
screenshots, generated assets) but the Telegram bridge only relays text. Users
on mobile-only Telegram have no way to receive these files without setting up
a separate channel (Drive auth, email, ngrok, etc.).

Concrete trigger: built a 55.8 MB Flutter release APK on the host, wanted to
install it on the phone — no path through the bot, had to fall back to Drive
OAuth or a LAN HTTP server.

## Proposal

Wire `bot.telegram.sendDocument` (Telegraf) into the harness so Claude can
deliver a local file to the originating chat as a Telegram document.

Two surface options, pick one:

1. **Convention-based** — Claude writes a file under a watched dir
   (e.g. `.uploads/<chatId>/`) and the harness auto-sends every new file there
   to that chat, then deletes it. Zero new tool surface; works through
   existing `Write`/`Bash`.
2. **Explicit MCP tool** — `mcp__claudebot__send_file({ path, caption? })`
   that the harness exposes per-session. Cleaner audit trail, explicit
   per-call permission prompt, no race with arbitrary writes.

Lean toward #2 — sending a file out of the host is a meaningful action and
should go through the same permission gate as Bash/Write rather than be a
side-effect of writing to a magic folder.

## Constraints to handle

- Telegram document size cap: **50 MB for bots** (2 GB only via local Bot API
  server). For files over 50 MB the tool should error out cleanly with a
  message Claude can relay (or fall back to chunking / a Drive link).
- Path must be confined to the chat's `workspaceDir` (or an explicit
  allowlist) — don't let a prompt-injected response exfiltrate `.env`.
- MIME type detection (Telegram uses extensions for the icon, but explicit
  MIME helps).
- Group/channel chats: send to the same `chatId` the message came from, not
  the user DM.

## Acceptance criteria

- From a chat, Claude can call the tool with a path inside the workspace and
  the file arrives as a Telegram document attachment in the same chat.
- Files >50 MB return a structured error; Claude relays a useful message.
- Paths outside the workspace are rejected before the Telegram API call.
- Per-call permission prompt respects the existing permission mode.

## Out of scope

- Inbound files from Telegram → workspace (already handled by `.uploads/`).
- Voice/photo-specific endpoints (`sendVoice`, `sendPhoto`); plain
  `sendDocument` covers everything as a fallback.

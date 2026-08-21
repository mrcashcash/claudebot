import {
  describeSession,
  findExistingSession,
  isFullSessionId,
  projectsDirFor,
} from "../services/claudeSessions.ts";
import * as sessions from "../state/sessions.ts";
import * as users from "../state/users.ts";
import { log } from "../state/logger.ts";
import type { TurnIO } from "./turnIO.ts";

/**
 * "Paste an id to hop sessions." A message whose entire body is a session id
 * (or an 8+ char hex prefix of one) switches the chat's live Claude session
 * instead of being sent to Claude as a prompt — so continuing yesterday's
 * conversation costs one paste, not `/resume <id>`.
 *
 * Deliberately conservative, because a false positive would eat a real prompt:
 *
 * - Full UUID → always consumed. A bare UUID is never a genuine prompt, so an
 *   unknown one gets a "not in this workspace" reply rather than being handed
 *   to Claude.
 * - Hex prefix (8..35 chars) → consumed only if it resolves to a transcript on
 *   disk (or ambiguously to several). Anything else falls through untouched.
 */

// 8+ leading hex chars, then only hex/hyphens. Bounded by a full UUID's length.
const BARE_ID_RE = /^[0-9a-f]{8}[0-9a-f-]*$/i;
const MAX_ID_LEN = 36;

export interface SessionSwitchDeps {
  io: TurnIO;
  chatId: string;
  userId: number | string;
  gatewayDir: string;
}

function ageString(ms: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function sizeString(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function preview(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}

/** Strip chat decoration around a pasted id: backticks, quotes, trailing dot. */
function normalizeToken(raw: string): string {
  return raw
    .trim()
    .replace(/^[`'"([<]+/, "")
    .replace(/[`'")\]>.,]+$/, "")
    .trim();
}

async function reply(io: TurnIO, text: string): Promise<void> {
  await io.reply(text, { parseMode: "markdown" });
}

/**
 * Returns true when the message was consumed as a session switch and must NOT
 * be forwarded to Claude as a prompt.
 */
export async function maybeSwitchSession(
  deps: SessionSwitchDeps,
  rawText: string,
): Promise<boolean> {
  const token = normalizeToken(rawText);
  if (token.length < 8 || token.length > MAX_ID_LEN) return false;
  if (!BARE_ID_RE.test(token)) return false;

  const { io, chatId, userId, gatewayDir } = deps;
  const ws = users.effectiveWorkspace(chatId, userId, gatewayDir);
  const isFull = isFullSessionId(token);
  const found = await findExistingSession(ws, token);

  if (found === "ambiguous") {
    await reply(
      io,
      `❓ \`${token}\` matches more than one session in this workspace. Send a few more characters, or use \`/resume\` to see the list.`,
    );
    return true;
  }

  if (!found) {
    // A bare full UUID can only have been meant as a switch, so answer it.
    // A short prefix might be a real (if odd) prompt — let it through.
    if (!isFull) return false;
    await reply(
      io,
      `❌ No session \`${token}\` in \`${projectsDirFor(ws)}\`.\n` +
        `That id belongs to another workspace or another machine. Check \`/resume\` for this workspace's sessions.`,
    );
    return true;
  }

  const current = sessions.get(chatId).sessionId;
  if (current === found.id) {
    await reply(
      io,
      `✅ Already on \`${found.id}\` — nothing to switch. Just send your message.`,
    );
    return true;
  }

  await sessions.update(chatId, { sessionId: found.id });
  void log({
    category: "turn",
    event: "session.switch",
    chatId,
    userId,
    sessionId: found.id,
    previousSessionId: current,
    trigger: "bare_id",
  });

  const previous = current ? await describeSession(ws, current) : null;
  const lines = [
    `↪ Switched to session \`${found.id}\``,
    `_${ageString(found.mtimeMs)} · ${sizeString(found.sizeBytes)}_`,
    ...(found.preview ? [`_opened with:_ ${preview(found.preview)}`] : []),
    "",
    "Your next message continues that conversation.",
  ];
  if (current) {
    lines.push(
      `Previous: \`${current}\`${previous?.preview ? ` — _${preview(previous.preview, 60)}_` : ""}`,
    );
    lines.push("Send that id to switch back.");
  }
  await reply(io, lines.join("\n"));
  return true;
}

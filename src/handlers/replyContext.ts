import type { Message } from "telegraf/types";

const QUOTE_MAX = 500;

/**
 * If the user is replying to another message, format a short quote prefix to
 * prepend to the prompt. Lets Claude see what the user is referencing —
 * particularly useful in groups where the reply may not be to the bot.
 *
 * Always returns a string (possibly empty) so callers can do
 * `${buildReplyContext(...)}${userText}` unconditionally.
 */
export function buildReplyContext(reply: Message | undefined): string {
  if (!reply) return "";
  const author = describeAuthor(reply);
  const body = extractText(reply);
  if (body && body.trim().length > 0) {
    const truncated =
      body.length > QUOTE_MAX ? body.slice(0, QUOTE_MAX) + "…" : body;
    return `[In reply to ${author}:\n"${truncated}"]\n\n`;
  }
  // Media-only reply target — note the kind so Claude knows it isn't text.
  const kind = describeMediaKind(reply);
  if (kind) return `[In reply to a ${kind} from ${author}]\n\n`;
  return `[In reply to ${author}]\n\n`;
}

function describeAuthor(reply: Message): string {
  const from = reply.from;
  if (!from) return "someone";
  if (from.username) return `@${from.username}`;
  const fullName = [from.first_name, from.last_name]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join(" ");
  return fullName || "someone";
}

function extractText(reply: Message): string | undefined {
  if ("text" in reply && typeof reply.text === "string") return reply.text;
  if ("caption" in reply && typeof reply.caption === "string")
    return reply.caption;
  return undefined;
}

function describeMediaKind(reply: Message): string | undefined {
  if ("photo" in reply) return "photo";
  if ("voice" in reply) return "voice message";
  if ("audio" in reply) return "audio";
  if ("video" in reply) return "video";
  if ("document" in reply) return "document";
  if ("sticker" in reply) return "sticker";
  return undefined;
}

import type { Context } from "telegraf";
import type { Message, MessageEntity } from "telegraf/types";
import * as sessions from "../state/sessions.ts";
import {
  VALID_RESPOND_MODES,
  type RespondMode,
} from "../handlers/respondModes.ts";

export { VALID_RESPOND_MODES, type RespondMode };

/**
 * Decide whether the bot should respond to a message in this chat.
 *
 * - DMs always respond (the per-chat respondTo is ignored).
 * - Groups consult `sessions.get(chatId).respondTo`, defaulting to "always"
 *   so existing groups don't change behavior on upgrade.
 * - "mention" passes if the bot is @-mentioned anywhere in the text/caption
 *   entities, or if the message is a reply to a bot message.
 * - "reply" passes only on reply-to-bot.
 *
 * Slash commands are routed by Telegraf separately and don't go through
 * this gate, so /help etc. always work even in mention mode.
 */
export function shouldRespond(ctx: Context): boolean {
  const chat = ctx.chat;
  if (!chat) return false;
  if (chat.type === "private") return true;
  const mode = (sessions.get(chat.id).respondTo ?? "always") as RespondMode;
  if (mode === "always") return true;

  const msg = ctx.message;
  if (!msg) return false;

  const botId = ctx.botInfo?.id;
  const isReplyToBot =
    botId !== undefined &&
    "reply_to_message" in msg &&
    msg.reply_to_message?.from?.id === botId;
  if (isReplyToBot) return true;
  if (mode === "reply") return false;

  // mode === "mention"
  const botUsername = ctx.botInfo?.username;
  if (!botUsername) return false;
  return mentionsBot(msg, botUsername);
}

function mentionsBot(msg: Message, botUsername: string): boolean {
  const target = "@" + botUsername.toLowerCase();
  const text =
    "text" in msg && typeof msg.text === "string"
      ? msg.text
      : "caption" in msg && typeof msg.caption === "string"
        ? msg.caption
        : "";
  if (text.length === 0) return false;
  const entities: MessageEntity[] | undefined =
    "entities" in msg && Array.isArray(msg.entities)
      ? msg.entities
      : "caption_entities" in msg && Array.isArray(msg.caption_entities)
        ? msg.caption_entities
        : undefined;
  if (!entities) return false;
  for (const e of entities) {
    if (e.type !== "mention") continue;
    const seg = text.substring(e.offset, e.offset + e.length).toLowerCase();
    if (seg === target) return true;
  }
  return false;
}

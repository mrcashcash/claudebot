/**
 * Transport-agnostic IO surface for a single turn — enough for the turn
 * engine, buildCanUseTool, questions.ask, and streamingReply to drive a
 * conversation without knowing whether the underlying transport is Telegram,
 * Slack, etc.
 *
 * Implementations:
 *   - Telegram → src/telegram/io.ts (ioFromContext, ioFromTelegram)
 *   - Slack    → src/slack/io.ts (ioFromSlack)
 *
 * IDs are strings on this surface. Telegram numeric ids are stringified at
 * the boundary; Slack ids (channel "C…", user "U…", message ts "1234.5678")
 * are already strings.
 */

export type ButtonGrid = Array<
  Array<{ label: string; callbackId: string }>
>;

export type ParseMode = "markdown" | "plain";

export type ChatKind = "dm" | "group";

export interface ReplyOptions {
  parseMode?: ParseMode;
  buttons?: ButtonGrid;
}

export interface SentMessage {
  messageId: string;
}

export interface TurnIO {
  /** Stringified channel/chat id. */
  chatId: string;
  /** "dm" for private chats / Slack IMs; "group" for group chats / Slack channels. */
  chatKind: ChatKind;
  /** Which transport this IO speaks. Used by the cron router to pick a kickOff fn. */
  transport: "telegram" | "slack";

  reply(text: string, opts?: ReplyOptions): Promise<SentMessage>;
  /** Edit a previously sent message. Implementations should silently swallow
   *  "message is not modified" style errors so callers don't need to. */
  editMessage(
    messageId: string,
    text: string,
    opts?: ReplyOptions,
  ): Promise<void>;
  /** Remove the inline keyboard / actions block from a message without
   *  changing its text. Used to freeze an answered approval prompt. */
  removeButtons(messageId: string): Promise<void>;
  /** Best-effort typing indicator. No-op where the transport has no equivalent. */
  sendChatAction(action: "typing"): Promise<void>;

  /** Transport-specific escape hatches (Telegram-only for now). Slack TTS
   *  support is a follow-up — calling these on a Slack IO is a no-op. */
  sendVoice?(audio: Buffer, filename: string): Promise<void>;
  sendAudio?(audio: Buffer, filename: string): Promise<void>;
}

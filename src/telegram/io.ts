import type { Context, Telegraf } from "telegraf";
import type {
  ButtonGrid,
  ChatKind,
  ReplyOptions,
  TurnIO,
} from "../handlers/turnIO.ts";

type TelegramClient = Telegraf["telegram"];

const TELEGRAM_MAX_TEXT = 4096;

function isNotModifiedError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    description?: unknown;
    message?: unknown;
    response?: { description?: unknown };
  };
  const candidates = [e.response?.description, e.description, e.message];
  for (const c of candidates) {
    if (typeof c === "string" && /not modified/i.test(c)) return true;
  }
  return false;
}

function tgKeyboard(buttons: ButtonGrid | undefined) {
  if (!buttons || buttons.length === 0) return undefined;
  return {
    reply_markup: {
      inline_keyboard: buttons.map((row) =>
        row.map((b) => ({ text: b.label, callback_data: b.callbackId })),
      ),
    },
  };
}

function tgReplyExtra(opts?: ReplyOptions): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  if (opts?.parseMode === "markdown") extra.parse_mode = "Markdown";
  const kb = tgKeyboard(opts?.buttons);
  if (kb) Object.assign(extra, kb);
  return extra;
}

function buildTelegramIO(
  telegram: TelegramClient,
  chatIdNum: number,
  chatKind: ChatKind,
): TurnIO {
  const chatId = String(chatIdNum);
  return {
    chatId,
    chatKind,
    transport: "telegram",
    async reply(text, opts) {
      const slice = text.slice(0, TELEGRAM_MAX_TEXT);
      const extra = tgReplyExtra(opts);
      try {
        const sent = await telegram.sendMessage(chatIdNum, slice, extra);
        return { messageId: String(sent.message_id) };
      } catch (err) {
        if (opts?.parseMode === "markdown") {
          const plain = slice.replace(/[*_`]/g, "");
          const sent = await telegram.sendMessage(
            chatIdNum,
            plain,
            tgKeyboard(opts.buttons),
          );
          return { messageId: String(sent.message_id) };
        }
        throw err;
      }
    },
    async editMessage(messageId, text, opts) {
      const slice = text.slice(0, TELEGRAM_MAX_TEXT);
      const mid = Number(messageId);
      const extra = tgReplyExtra(opts);
      try {
        await telegram.editMessageText(chatIdNum, mid, undefined, slice, extra);
      } catch (err) {
        if (isNotModifiedError(err)) return;
        if (opts?.parseMode === "markdown") {
          try {
            const plain = slice.replace(/[*_`]/g, "");
            await telegram.editMessageText(
              chatIdNum,
              mid,
              undefined,
              plain,
              tgKeyboard(opts.buttons),
            );
            return;
          } catch (err2) {
            if (isNotModifiedError(err2)) return;
            throw err2;
          }
        }
        throw err;
      }
    },
    async removeButtons(messageId) {
      try {
        await telegram.editMessageReplyMarkup(
          chatIdNum,
          Number(messageId),
          undefined,
          undefined,
        );
      } catch {
        // ignore — message may already be edited or deleted
      }
    },
    async sendChatAction(action) {
      try {
        await telegram.sendChatAction(chatIdNum, action);
      } catch {
        // Telegram hiccup; ignore.
      }
    },
    async sendVoice(audio, filename) {
      await telegram.sendVoice(chatIdNum, { source: audio, filename });
    },
    async sendAudio(audio, filename) {
      await telegram.sendAudio(chatIdNum, { source: audio, filename });
    },
  };
}

export function ioFromContext(ctx: Context): TurnIO {
  const chat = ctx.chat;
  if (!chat) {
    throw new Error("ioFromContext: ctx.chat is undefined");
  }
  const chatKind: ChatKind = chat.type === "private" ? "dm" : "group";
  return buildTelegramIO(ctx.telegram, chat.id, chatKind);
}

export function ioFromTelegram(
  telegram: TelegramClient,
  chatId: number,
  chatKind: ChatKind = "dm",
): TurnIO {
  return buildTelegramIO(telegram, chatId, chatKind);
}

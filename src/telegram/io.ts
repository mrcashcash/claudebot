import fs from "node:fs/promises";
import path from "node:path";
import type { Context, Telegraf } from "telegraf";
import type {
  ButtonGrid,
  ChatKind,
  ReplyOptions,
  TurnIO,
} from "../handlers/turnIO.ts";

type TelegramClient = Telegraf["telegram"];

const TELEGRAM_MAX_TEXT = 4096;

// Telegram cloud Bot API caps sendDocument at 50 MB. For 50–100 MB files we
// split into ~49 MB chunks (the upper guidance bound, with HTTP/multipart
// overhead headroom). A self-hosted Bot API server would lift this to 2 GB
// but the gateway doesn't run one.
const TELEGRAM_DOC_MAX_BYTES = 50 * 1024 * 1024;
const TELEGRAM_CHUNK_BYTES = 49 * 1024 * 1024;

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
    async sendDocument(filePath, opts) {
      const stat = await fs.stat(filePath);
      const totalBytes = stat.size;
      const baseName = path.basename(filePath);
      if (totalBytes <= TELEGRAM_DOC_MAX_BYTES) {
        const buf = await fs.readFile(filePath);
        await telegram.sendDocument(
          chatIdNum,
          { source: buf, filename: baseName },
          opts?.caption ? { caption: opts.caption } : {},
        );
        return { chunks: 1 };
      }
      // Split into ~49 MB pieces. Each piece is sent as <name>.partNN-of-MM
      // so the user can `cat` / `copy /b` them back together in order.
      const totalChunks = Math.ceil(totalBytes / TELEGRAM_CHUNK_BYTES);
      const pad = String(totalChunks).length;
      const handle = await fs.open(filePath, "r");
      try {
        for (let i = 0; i < totalChunks; i++) {
          const start = i * TELEGRAM_CHUNK_BYTES;
          const len = Math.min(TELEGRAM_CHUNK_BYTES, totalBytes - start);
          const buf = Buffer.alloc(len);
          await handle.read(buf, 0, len, start);
          const idx = String(i + 1).padStart(pad, "0");
          const totalStr = String(totalChunks).padStart(pad, "0");
          const partName = `${baseName}.part${idx}-of-${totalStr}`;
          const caption =
            i === 0
              ? `${opts?.caption ? opts.caption + "\n\n" : ""}📎 ${baseName} split into ${totalChunks} parts (${(totalBytes / 1024 / 1024).toFixed(1)} MB total). Reassemble: \`cat ${baseName}.part*\` (Linux/Mac) or \`copy /b ${baseName}.part01-of-${totalStr}+...+${baseName}.part${totalStr}-of-${totalStr} ${baseName}\` (Windows).`
              : `part ${idx}/${totalStr}`;
          await telegram.sendDocument(
            chatIdNum,
            { source: buf, filename: partName },
            { caption },
          );
        }
      } finally {
        await handle.close();
      }
      return { chunks: totalChunks };
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

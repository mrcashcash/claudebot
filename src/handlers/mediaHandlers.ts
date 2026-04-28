import { Telegraf, type Context } from "telegraf";
import { message } from "telegraf/filters";
import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.ts";
import type { AskClaudeAttachment } from "../services/claude.ts";
import * as users from "../state/users.ts";
import { transcribeAudio } from "../services/voice/index.ts";
import { logError } from "../state/logger.ts";
import { buildReplyContext } from "./replyContext.ts";
import { shouldRespond } from "./respondGate.ts";

const IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/**
 * Telegram delivers each photo of an album as its own update with a shared
 * media_group_id. Buffer them until this many ms pass with no new photo for
 * the group, then dispatch one turn with all attachments. 600ms is plenty —
 * Telegram delivers album items back-to-back.
 */
const ALBUM_DEBOUNCE_MS = 600;

export interface MediaHandlerDeps {
  config: Config;
  kickOffTurn: (
    ctx: Context,
    chatId: number,
    prompt: string,
    attachments?: AskClaudeAttachment[],
    traceStart?: number,
    inputWasVoice?: boolean,
  ) => void;
}

type IncomingAudio = {
  fileId: string;
  fileUniqueId: string;
  durationSec: number;
  fileName: string | undefined;
  /** Human label for log + prompt prefix ("voice" or "audio"). */
  kind: "voice" | "audio";
};

function sanitizeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
}

interface PendingAlbum {
  chatId: number;
  /** Any ctx from a same-album photo; kickOffTurn only needs ctx for telegram + from. */
  ctxAny: Context;
  attachments: AskClaudeAttachment[];
  /** First non-empty caption seen — Telegram only attaches it to one item. */
  caption: string;
  /** Reply-to context from whichever album item carried the reply. */
  replyContext: string;
  timer: NodeJS.Timeout | null;
}

export function registerMediaHandlers(
  bot: Telegraf,
  deps: MediaHandlerDeps,
): void {
  const { config, kickOffTurn } = deps;

  const downloadTelegramFile = async (fileId: string): Promise<Buffer> => {
    const url = await bot.telegram.getFileLink(fileId);
    const r = await fetch(url.toString());
    if (!r.ok) throw new Error(`Telegram file fetch failed: ${r.status}`);
    const ab = await r.arrayBuffer();
    return Buffer.from(ab);
  };

  const pendingAlbums = new Map<string, PendingAlbum>();

  function dispatchAlbum(groupId: string): void {
    const album = pendingAlbums.get(groupId);
    pendingAlbums.delete(groupId);
    if (!album || album.attachments.length === 0) return;
    const count = album.attachments.length;
    const body =
      album.caption.length > 0
        ? album.caption
        : count === 1
          ? "Describe this image."
          : `Describe these ${count} images.`;
    kickOffTurn(
      album.ctxAny,
      album.chatId,
      album.replyContext + body,
      album.attachments,
    );
  }

  bot.on(message("photo"), async (ctx) => {
    const chatId = ctx.chat.id;
    const sizes = ctx.message.photo;
    const largest = sizes[sizes.length - 1];
    if (!largest) {
      await ctx.reply("No photo data received.");
      return;
    }
    const groupId = ctx.message.media_group_id;
    // Gate first to avoid downloading media we'll never reply to. For album
    // items, we still buffer if a sibling already passed the gate (album
    // exists in the map) — otherwise the captioned-but-non-first edge case
    // would lose photos.
    if (!shouldRespond(ctx) && !(groupId && pendingAlbums.has(groupId))) {
      return;
    }
    const caption =
      typeof ctx.message.caption === "string" ? ctx.message.caption : "";
    const replyContext = buildReplyContext(ctx.message.reply_to_message);

    let buf: Buffer;
    try {
      buf = await downloadTelegramFile(largest.file_id);
    } catch (err) {
      void logError("error.media", err, {
        kind: "photo",
        chatId,
        userId: ctx.from?.id,
      });
      console.error("[photo] download failed:", err);
      // For album items, swallow per-photo failures — siblings still dispatch.
      if (!groupId) {
        await ctx.reply(
          `Error handling photo: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }
    if (buf.byteLength > MAX_IMAGE_BYTES) {
      const sizeMsg = `❌ Image too large (${(buf.byteLength / 1024 / 1024).toFixed(1)} MB > 5 MB).`;
      if (!groupId) {
        await ctx.reply(sizeMsg);
      } else {
        // Tell the user which album item was dropped, but keep the rest going.
        await ctx.reply(sizeMsg + " (skipped this album item)");
      }
      return;
    }
    const attachment: AskClaudeAttachment = {
      type: "image",
      mediaType: "image/jpeg",
      base64: buf.toString("base64"),
    };

    if (!groupId) {
      const body = caption.length > 0 ? caption : "Describe this image.";
      kickOffTurn(ctx, chatId, replyContext + body, [attachment]);
      return;
    }

    let album = pendingAlbums.get(groupId);
    if (!album) {
      album = {
        chatId,
        ctxAny: ctx,
        attachments: [],
        caption: "",
        replyContext: "",
        timer: null,
      };
      pendingAlbums.set(groupId, album);
    }
    album.attachments.push(attachment);
    if (caption.length > 0 && album.caption.length === 0) {
      album.caption = caption;
    }
    if (replyContext.length > 0 && album.replyContext.length === 0) {
      album.replyContext = replyContext;
    }
    if (album.timer) clearTimeout(album.timer);
    album.timer = setTimeout(() => dispatchAlbum(groupId), ALBUM_DEBOUNCE_MS);
  });

  bot.on(message("document"), async (ctx) => {
    if (!shouldRespond(ctx)) return;
    const chatId = ctx.chat.id;
    const doc = ctx.message.document;
    const mime = doc.mime_type ?? "application/octet-stream";
    const caption =
      typeof ctx.message.caption === "string" ? ctx.message.caption : "";
    const replyContext = buildReplyContext(ctx.message.reply_to_message);
    try {
      const buf = await downloadTelegramFile(doc.file_id);

      if (IMAGE_MEDIA_TYPES.has(mime)) {
        if (buf.byteLength > MAX_IMAGE_BYTES) {
          await ctx.reply(
            `❌ Image too large (${(buf.byteLength / 1024 / 1024).toFixed(1)} MB > 5 MB).`,
          );
          return;
        }
        const body = caption.length > 0 ? caption : "Describe this image.";
        const attachment: AskClaudeAttachment = {
          type: "image",
          mediaType: mime,
          base64: buf.toString("base64"),
        };
        kickOffTurn(ctx, chatId, replyContext + body, [attachment]);
        return;
      }

      const userId = ctx.from?.id;
      if (userId === undefined) return;
      const ws = users.effectiveWorkspace(chatId, userId, config.gatewayDir);
      const uploadsDir = path.join(ws, ".uploads");
      await fs.mkdir(uploadsDir, { recursive: true });
      const safeName = sanitizeFilename(doc.file_name ?? `${doc.file_id}.bin`);
      const filename = `${Date.now()}-${safeName}`;
      const dest = path.join(uploadsDir, filename);
      await fs.writeFile(dest, buf);

      const rel = path.relative(ws, dest).replace(/\\/g, "/");
      const body =
        `User uploaded a file at \`${rel}\` (mime: ${mime}, ${buf.byteLength} bytes).` +
        (caption ? `\nCaption: ${caption}` : "") +
        `\nUse Read or another appropriate tool to inspect it.`;
      kickOffTurn(ctx, chatId, replyContext + body);
    } catch (err) {
      void logError("error.media", err, {
        kind: "document",
        chatId,
        userId: ctx.from?.id,
        mime,
      });
      console.error("[document] failed:", err);
      await ctx.reply(
        `Error handling document: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  // Shared logic for voice + audio. Telegraf's `voice` and `audio` filters
  // expose slightly different shapes, so the caller passes the relevant
  // fields. Returns immediately (handler-must-return-fast convention) and
  // does the slow ffmpeg+whisper work fire-and-forget — without that, the
  // Telegraf polling loop would stall while a 30-second clip transcribes.
  const handleAudioMessage = (
    ctx: Context,
    chatId: number,
    audio: IncomingAudio,
    caption: string,
    replyContext: string,
  ): void => {
    const userId = ctx.from?.id;
    if (userId === undefined) return;
    const voice = users.voiceFor(userId);
    if (!voice.enabled) {
      void ctx.reply(
        "Voice transcription is disabled — set voice.enabled=true in your config.",
      );
      return;
    }
    if (audio.durationSec > voice.maxDurationSec) {
      void ctx.reply(
        `❌ ${audio.kind === "voice" ? "Voice message" : "Audio file"} too long (${audio.durationSec}s > ${voice.maxDurationSec}s).`,
      );
      return;
    }

    void (async () => {
      let placeholderId: number | undefined;
      const tArrival = Date.now();
      try {
        const placeholder = await ctx.reply("🎤 Transcribing…");
        placeholderId = placeholder.message_id;

        const tDownload = Date.now();
        const buf = await downloadTelegramFile(audio.fileId);
        const downloadMs = Date.now() - tDownload;
        const ws = users.effectiveWorkspace(chatId, userId, config.gatewayDir);
        const uploadsDir = path.join(ws, ".uploads");
        await fs.mkdir(uploadsDir, { recursive: true });

        const ext =
          audio.kind === "voice"
            ? ".ogg"
            : path.extname(audio.fileName ?? "") || ".bin";
        const safeStem = sanitizeFilename(
          audio.fileName
            ? path.basename(audio.fileName, path.extname(audio.fileName))
            : `${audio.kind}-${audio.fileUniqueId}`,
        );
        const filename = `${Date.now()}-${audio.kind}-${safeStem}${ext}`;
        const inputPath = path.join(uploadsDir, filename);
        await fs.writeFile(inputPath, buf);

        const tTranscribe = Date.now();
        const { text, timings } = await transcribeAudio({
          inputPath,
          model: voice.whisperModel,
          language: voice.language,
          ffmpegPath: voice.ffmpegPath,
        });
        const transcribeMs = Date.now() - tTranscribe;
        console.log(
          `[${audio.kind}] chat=${chatId} dur=${audio.durationSec}s ` +
            `backend=${timings.backend} download=${downloadMs}ms ` +
            `decode=${timings.decodeMs}ms modelLoad=${timings.modelLoadMs}ms ` +
            `infer=${timings.inferMs}ms transcribe-total=${transcribeMs}ms`,
        );

        // Transcript is fed silently to Claude — drop the placeholder.
        if (placeholderId !== undefined) {
          await ctx.telegram
            .deleteMessage(chatId, placeholderId)
            .catch(() => {});
          placeholderId = undefined;
        }

        const transcript = text.trim();
        if (transcript.length === 0) {
          await ctx.reply(
            `🎤 Couldn't make out any speech in that ${audio.kind === "voice" ? "voice message" : "audio file"}.`,
          );
          return;
        }

        const prompt =
          replyContext +
          `[User sent a ${audio.durationSec}s ${audio.kind} message. Transcript:]\n${transcript}` +
          (caption ? `\n\n[Caption: ${caption}]` : "");
        kickOffTurn(ctx, chatId, prompt, undefined, tArrival, true);
      } catch (err) {
        void logError("error.media", err, {
          kind: audio.kind,
          chatId,
          userId,
          durationSec: audio.durationSec,
        });
        console.error(`[${audio.kind}] failed:`, err);
        const msg = `❌ Transcription failed: ${err instanceof Error ? err.message : String(err)}`;
        if (placeholderId !== undefined) {
          try {
            await ctx.telegram.editMessageText(
              chatId,
              placeholderId,
              undefined,
              msg,
            );
          } catch {
            await ctx.reply(msg);
          }
        } else {
          await ctx.reply(msg);
        }
      }
    })();
  };

  bot.on(message("voice"), (ctx) => {
    if (!shouldRespond(ctx)) return;
    const chatId = ctx.chat.id;
    const v = ctx.message.voice;
    const caption =
      typeof ctx.message.caption === "string" ? ctx.message.caption : "";
    const replyContext = buildReplyContext(ctx.message.reply_to_message);
    handleAudioMessage(
      ctx,
      chatId,
      {
        fileId: v.file_id,
        fileUniqueId: v.file_unique_id,
        durationSec: v.duration,
        fileName: undefined,
        kind: "voice",
      },
      caption,
      replyContext,
    );
  });

  bot.on(message("audio"), (ctx) => {
    if (!shouldRespond(ctx)) return;
    const chatId = ctx.chat.id;
    const a = ctx.message.audio;
    const caption =
      typeof ctx.message.caption === "string" ? ctx.message.caption : "";
    const replyContext = buildReplyContext(ctx.message.reply_to_message);
    handleAudioMessage(
      ctx,
      chatId,
      {
        fileId: a.file_id,
        fileUniqueId: a.file_unique_id,
        durationSec: a.duration,
        fileName: a.file_name,
        kind: "audio",
      },
      caption,
      replyContext,
    );
  });
}

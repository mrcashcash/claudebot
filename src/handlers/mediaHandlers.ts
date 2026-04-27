import { Telegraf, type Context } from "telegraf";
import { message } from "telegraf/filters";
import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.ts";
import type { AskClaudeAttachment } from "../services/claude.ts";
import * as sessions from "../state/sessions.ts";
import { transcribeAudio } from "../services/voice/index.ts";
import { effectiveWorkspace } from "./commands.ts";

const IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface MediaHandlerDeps {
  config: Config;
  kickOffTurn: (
    ctx: Context,
    chatId: number,
    prompt: string,
    attachments?: AskClaudeAttachment[],
    traceStart?: number,
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

  bot.on(message("photo"), async (ctx) => {
    const chatId = ctx.chat.id;
    const sizes = ctx.message.photo;
    const largest = sizes[sizes.length - 1];
    if (!largest) {
      await ctx.reply("No photo data received.");
      return;
    }
    try {
      const buf = await downloadTelegramFile(largest.file_id);
      if (buf.byteLength > MAX_IMAGE_BYTES) {
        await ctx.reply(
          `❌ Image too large (${(buf.byteLength / 1024 / 1024).toFixed(1)} MB > 5 MB).`,
        );
        return;
      }
      const caption =
        typeof ctx.message.caption === "string" ? ctx.message.caption : "";
      const prompt = caption.length > 0 ? caption : "Describe this image.";
      const attachment: AskClaudeAttachment = {
        type: "image",
        mediaType: "image/jpeg",
        base64: buf.toString("base64"),
      };
      kickOffTurn(ctx, chatId, prompt, [attachment]);
    } catch (err) {
      console.error("[photo] failed:", err);
      await ctx.reply(
        `Error handling photo: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  bot.on(message("document"), async (ctx) => {
    const chatId = ctx.chat.id;
    const doc = ctx.message.document;
    const mime = doc.mime_type ?? "application/octet-stream";
    const caption =
      typeof ctx.message.caption === "string" ? ctx.message.caption : "";
    try {
      const buf = await downloadTelegramFile(doc.file_id);

      if (IMAGE_MEDIA_TYPES.has(mime)) {
        if (buf.byteLength > MAX_IMAGE_BYTES) {
          await ctx.reply(
            `❌ Image too large (${(buf.byteLength / 1024 / 1024).toFixed(1)} MB > 5 MB).`,
          );
          return;
        }
        const prompt = caption.length > 0 ? caption : "Describe this image.";
        const attachment: AskClaudeAttachment = {
          type: "image",
          mediaType: mime,
          base64: buf.toString("base64"),
        };
        kickOffTurn(ctx, chatId, prompt, [attachment]);
        return;
      }

      const state = sessions.get(chatId);
      const ws = effectiveWorkspace(state, config);
      const uploadsDir = path.join(ws, ".uploads");
      await fs.mkdir(uploadsDir, { recursive: true });
      const safeName = sanitizeFilename(doc.file_name ?? `${doc.file_id}.bin`);
      const filename = `${Date.now()}-${safeName}`;
      const dest = path.join(uploadsDir, filename);
      await fs.writeFile(dest, buf);

      const rel = path.relative(ws, dest).replace(/\\/g, "/");
      const prompt =
        `User uploaded a file at \`${rel}\` (mime: ${mime}, ${buf.byteLength} bytes).` +
        (caption ? `\nCaption: ${caption}` : "") +
        `\nUse Read or another appropriate tool to inspect it.`;
      kickOffTurn(ctx, chatId, prompt);
    } catch (err) {
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
  ): void => {
    if (!config.voice.enabled) {
      void ctx.reply("Voice transcription is disabled (VOICE_ENABLED=false).");
      return;
    }
    if (audio.durationSec > config.voice.maxDurationSec) {
      void ctx.reply(
        `❌ ${audio.kind === "voice" ? "Voice message" : "Audio file"} too long (${audio.durationSec}s > ${config.voice.maxDurationSec}s).`,
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
        const ws = effectiveWorkspace(sessions.get(chatId), config);
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
          model: config.voice.whisperModel,
          language: config.voice.language,
          ffmpegPath: config.voice.ffmpegPath,
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
          `[User sent a ${audio.durationSec}s ${audio.kind} message. Transcript:]\n${transcript}` +
          (caption ? `\n\n[Caption: ${caption}]` : "");
        kickOffTurn(ctx, chatId, prompt, undefined, tArrival);
      } catch (err) {
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
    const chatId = ctx.chat.id;
    const v = ctx.message.voice;
    const caption =
      typeof ctx.message.caption === "string" ? ctx.message.caption : "";
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
    );
  });

  bot.on(message("audio"), (ctx) => {
    const chatId = ctx.chat.id;
    const a = ctx.message.audio;
    const caption =
      typeof ctx.message.caption === "string" ? ctx.message.caption : "";
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
    );
  });
}

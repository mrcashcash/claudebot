import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import type { WhisperModel } from "./config.ts";

export interface TranscribeOptions {
  /** Absolute path to the source audio (Telegram voice = .ogg/Opus). */
  inputPath: string;
  /** Whisper model id (must match nodejs-whisper's MODEL_OBJECT keys). */
  model: WhisperModel;
  /** ISO 639-1 hint, or undefined for auto-detect. */
  language?: string;
  /** Directory for the transient .wav file. */
  workDir: string;
  /** Override path to ffmpeg. Defaults to bundled ffmpeg-static. */
  ffmpegPath?: string;
}

export interface TranscribeResult {
  text: string;
}

let cachedFfmpegPath: string | null | undefined = undefined;

async function resolveFfmpegPath(override?: string): Promise<string> {
  if (override && override.trim() !== "") {
    if (!existsSync(override)) {
      throw new Error(
        `FFMPEG_PATH points at a file that does not exist: ${override}`,
      );
    }
    return override;
  }
  if (cachedFfmpegPath === undefined) {
    const mod = (await import("ffmpeg-static")) as {
      default: string | null;
    };
    cachedFfmpegPath = mod.default;
  }
  if (cachedFfmpegPath === null || !existsSync(cachedFfmpegPath)) {
    throw new Error(
      "ffmpeg-static binary not found. The platform-specific optional " +
        "dependency may have failed to install. Either re-run `npm install` " +
        "with network access, or set FFMPEG_PATH to a system ffmpeg.",
    );
  }
  return cachedFfmpegPath;
}

/**
 * Convert any audio file to 16 kHz mono signed 16-bit PCM WAV via ffmpeg.
 * whisper.cpp requires this exact format.
 */
async function convertToWhisperWav(
  ffmpegPath: string,
  inputPath: string,
  wavPath: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        inputPath,
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        wavPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
    );
    let stderr = "";
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `ffmpeg exited with code ${code ?? "?"}: ${stderr.trim() || "(no stderr)"}`,
          ),
        );
      }
    });
  });
}

/**
 * whisper-cli's stdout looks like:
 *   [00:00:00.000 --> 00:00:03.420]   Hello world.
 *   [00:00:03.420 --> 00:00:05.000]   How are you?
 * plus assorted system/info lines. Strip the timestamps and discard noise.
 */
function cleanWhisperStdout(stdout: string): string {
  const out: string[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const m = raw.match(
      /^\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]\s*(.*)$/,
    );
    if (m && typeof m[1] === "string") {
      const text = m[1].trim();
      if (text.length > 0) out.push(text);
    }
  }
  return out
    .join(" ")
    .replace(/\[BLANK_AUDIO\]/gi, "")
    .replace(/\[SOUND\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function transcribeAudio(
  opts: TranscribeOptions,
): Promise<TranscribeResult> {
  const ffmpegPath = await resolveFfmpegPath(opts.ffmpegPath);

  await fs.mkdir(opts.workDir, { recursive: true });
  const baseName =
    path.basename(opts.inputPath, path.extname(opts.inputPath)) || "audio";
  const wavPath = path.join(opts.workDir, `${baseName}.${Date.now()}.wav`);

  try {
    await convertToWhisperWav(ffmpegPath, opts.inputPath, wavPath);

    // Lazy-load nodejs-whisper so the cold start doesn't pay for it on
    // chats that never send voice.
    const { nodewhisper } = await import("nodejs-whisper");

    const stdout = await nodewhisper(wavPath, {
      modelName: opts.model,
      autoDownloadModelName: opts.model,
      // We own cleanup. nodejs-whisper's flag uses sync fs.unlinkSync which
      // would race with our finally block; keep ownership here for clarity.
      removeWavFileAfterTranscription: false,
      whisperOptions: {
        language: opts.language ?? "auto",
        translateToEnglish: false,
        // Don't ask for any side-output files — we only want stdout.
        outputInText: false,
        outputInJson: false,
        outputInSrt: false,
        outputInVtt: false,
        outputInCsv: false,
        outputInLrc: false,
        outputInWords: false,
        outputInJsonFull: false,
      },
    });

    return { text: cleanWhisperStdout(stdout) };
  } finally {
    // Best-effort cleanup of the transient WAV. Ignore ENOENT.
    try {
      await fs.unlink(wavPath);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Pre-download the requested whisper.cpp model so the first user message
 * doesn't pay the download wait. Safe to call repeatedly — the underlying
 * helper short-circuits if the model file already exists.
 */
export async function ensureWhisperModel(model: WhisperModel): Promise<void> {
  // nodejs-whisper doesn't expose autoDownloadModel from its package root,
  // so we reach into the dist path. The CJS-via-ESM interop wraps the
  // default export an extra level — handle both shapes defensively so a
  // future package change doesn't break us silently.
  type AutoDownloadFn = (
    logger?: Console,
    autoDownloadModelName?: string,
    withCuda?: boolean,
    modelRootPath?: string,
  ) => Promise<string>;
  const mod = (await import("nodejs-whisper/dist/autoDownloadModel.js")) as {
    default: AutoDownloadFn | { default: AutoDownloadFn };
  };
  const fn: AutoDownloadFn =
    typeof mod.default === "function" ? mod.default : mod.default.default;
  await fn(console, model, false, undefined);
}

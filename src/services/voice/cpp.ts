import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { WhisperModel } from "../../config.ts";

export interface CppTranscribeOptions {
  inputPath: string;
  model: WhisperModel;
  language?: string;
  ffmpegPath: string;
}

export interface CppTranscribeResult {
  text: string;
  decodeMs: number;
  modelLoadMs: number;
  inferMs: number;
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
 * Generate a short (~0.5 s) silent WAV via ffmpeg's anullsrc filter. Used by
 * the cpp probe to exercise the lazy whisper-cli build without depending on
 * a checked-in binary asset. whisper.cpp rejects inputs shorter than 100 ms,
 * and a 0.1 s request can round down under that threshold on sample
 * boundaries — keep this comfortably above the limit.
 */
async function writeSilentWav(
  ffmpegPath: string,
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
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=16000:cl=mono",
        "-t",
        "0.5",
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
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `ffmpeg(silent) exited with code ${code ?? "?"}: ${stderr.trim() || "(no stderr)"}`,
          ),
        );
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

async function runNodeWhisper(
  wavPath: string,
  model: WhisperModel,
  language: string | undefined,
): Promise<string> {
  const { nodewhisper } = await import("nodejs-whisper");
  return await nodewhisper(wavPath, {
    modelName: model,
    autoDownloadModelName: model,
    removeWavFileAfterTranscription: false,
    whisperOptions: {
      language: language ?? "auto",
      translateToEnglish: false,
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
}

export async function transcribeCpp(
  opts: CppTranscribeOptions,
): Promise<CppTranscribeResult> {
  const workDir = path.dirname(opts.inputPath);
  await fs.mkdir(workDir, { recursive: true });
  const baseName =
    path.basename(opts.inputPath, path.extname(opts.inputPath)) || "audio";
  const wavPath = path.join(workDir, `${baseName}.${Date.now()}.wav`);

  try {
    const tDecode = Date.now();
    await convertToWhisperWav(opts.ffmpegPath, opts.inputPath, wavPath);
    const decodeMs = Date.now() - tDecode;

    const tInfer = Date.now();
    const stdout = await runNodeWhisper(wavPath, opts.model, opts.language);
    const inferMs = Date.now() - tInfer;

    return {
      text: cleanWhisperStdout(stdout),
      decodeMs,
      // The probe pays the build/download cost before the user's first real
      // call, so user-facing transcribes never see a cold load.
      modelLoadMs: 0,
      inferMs,
    };
  } finally {
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
export async function ensureCpp(model: WhisperModel): Promise<void> {
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

/**
 * Run a one-shot transcription on a 0.1 s silent WAV using the configured
 * model. Exercises the lazy whisper-cli build so a host without a working
 * C++ toolchain fails *here* and the router can pin to HF before a real
 * voice message arrives. Throws on any failure.
 */
export async function probeCpp(
  ffmpegPath: string,
  model: WhisperModel,
): Promise<void> {
  const probeDir = path.join(os.tmpdir(), "claudebot-voice-probe");
  await fs.mkdir(probeDir, { recursive: true });
  const wavPath = path.join(probeDir, `silent.${Date.now()}.wav`);
  try {
    await writeSilentWav(ffmpegPath, wavPath);
    await runNodeWhisper(wavPath, model, undefined);
  } finally {
    try {
      await fs.unlink(wavPath);
    } catch {
      /* ignore */
    }
  }
}

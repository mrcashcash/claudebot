import { existsSync } from "node:fs";

import type { WhisperModel } from "../../config.ts";
import { transcribeCpp, ensureCpp, probeCpp } from "./cpp.ts";
import { transcribeHF, ensureHF } from "./hf.ts";
import { log } from "../../state/logger.ts";

export type VoiceBackend = "cpp" | "hf";

export interface TranscribeOptions {
  /** Absolute path to the source audio (Telegram voice = .ogg/Opus). */
  inputPath: string;
  /** Whisper model id (one of WhisperModel). */
  model: WhisperModel;
  /** ISO 639-1 hint, or undefined for auto-detect. */
  language?: string;
  /** Override path to ffmpeg. Defaults to bundled ffmpeg-static. */
  ffmpegPath?: string;
}

export interface TranscribeTimings {
  /** ffmpeg decode of the input file. */
  decodeMs: number;
  /**
   * Cold model-load cost paid by this call. cpp pays it inside the probe
   * before any user-facing call, so the cpp path always reports 0. HF
   * reports the pipeline-load wait (>0 on first call, ~0 thereafter).
   */
  modelLoadMs: number;
  /** Pure inference time (excluding decode + load). */
  inferMs: number;
  backend: VoiceBackend;
}

export interface TranscribeResult {
  text: string;
  timings: TranscribeTimings;
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

let backendChoice: Promise<VoiceBackend> | null = null;

async function selectBackend(
  ffmpegPath: string,
  model: WhisperModel,
): Promise<VoiceBackend> {
  // Step 1: is the package present at all?
  try {
    await import("nodejs-whisper");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void log({
      category: "error",
      event: "error.voice_backend",
      level: "warn",
      stage: "import",
      message: msg,
      fallback: "hf",
    });
    console.warn(
      `[voice] cpp backend unavailable: ${msg} — falling back to transformers.js`,
    );
    return "hf";
  }
  // Step 2: does it actually run on this host? whisper-cli is built lazily
  // on first invocation, so a real (silent) transcription is the only honest
  // probe — a bare import passes even when the toolchain is missing.
  try {
    await probeCpp(ffmpegPath, model);
    return "cpp";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void log({
      category: "error",
      event: "error.voice_backend",
      level: "warn",
      stage: "probe",
      message: msg,
      fallback: "hf",
    });
    console.warn(
      `[voice] cpp backend unavailable: ${msg} — falling back to transformers.js`,
    );
    return "hf";
  }
}

function getBackend(
  ffmpegPath: string,
  model: WhisperModel,
): Promise<VoiceBackend> {
  if (!backendChoice) {
    backendChoice = selectBackend(ffmpegPath, model);
  }
  return backendChoice;
}

export async function transcribeAudio(
  opts: TranscribeOptions,
): Promise<TranscribeResult> {
  const ffmpegPath = await resolveFfmpegPath(opts.ffmpegPath);
  const backend = await getBackend(ffmpegPath, opts.model);
  if (backend === "cpp") {
    const r = await transcribeCpp({
      inputPath: opts.inputPath,
      model: opts.model,
      language: opts.language,
      ffmpegPath,
    });
    return {
      text: r.text,
      timings: {
        decodeMs: r.decodeMs,
        modelLoadMs: r.modelLoadMs,
        inferMs: r.inferMs,
        backend: "cpp",
      },
    };
  }
  const r = await transcribeHF({
    inputPath: opts.inputPath,
    model: opts.model,
    language: opts.language,
    ffmpegPath,
  });
  return {
    text: r.text,
    timings: {
      decodeMs: r.decodeMs,
      modelLoadMs: r.modelLoadMs,
      inferMs: r.inferMs,
      backend: "hf",
    },
  };
}

/**
 * Resolve the active backend and pre-warm its model cache. Called at boot
 * when WHISPER_PRELOAD=true so the first user message doesn't pay the
 * cold-load wait. Returns the chosen backend so the caller can log it.
 */
export async function ensureWhisperModel(
  model: WhisperModel,
): Promise<VoiceBackend> {
  const ffmpegPath = await resolveFfmpegPath();
  const backend = await getBackend(ffmpegPath, model);
  if (backend === "cpp") {
    await ensureCpp(model);
  } else {
    await ensureHF(model);
  }
  return backend;
}

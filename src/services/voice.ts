import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import type { WhisperModel } from "../config.ts";

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
  /** ffmpeg decode of input file → 16 kHz mono Float32. */
  decodeMs: number;
  /**
   * Time spent inside getPipeline(): if `pipelineCached` is false this is
   * the cold-start cost (HuggingFace download + ONNX runtime init + weight
   * load). If true, this is just the time to await an already-resolved
   * promise — typically <5ms — unless the entry exists but the promise is
   * still pending (e.g. preload in flight), in which case this is the
   * remaining wait.
   */
  pipelineMs: number;
  /** True if `pipelineCache` already had an entry for this model id. */
  pipelineCached: boolean;
  /** transformers.js ASR pipeline call (excluding pipeline load). */
  inferMs: number;
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

/**
 * Decode any audio file via ffmpeg directly into a 16 kHz mono Float32Array —
 * the exact format @huggingface/transformers' ASR pipeline expects. We pipe
 * raw f32le samples on stdout instead of writing a temp WAV.
 */
async function decodeToFloat32(
  ffmpegPath: string,
  inputPath: string,
): Promise<Float32Array> {
  return await new Promise<Float32Array>((resolve, reject) => {
    const child = spawn(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        inputPath,
        "-ar",
        "16000",
        "-ac",
        "1",
        "-f",
        "f32le",
        "-",
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    const chunks: Buffer[] = [];
    let total = 0;
    child.stdout.on("data", (c: Buffer) => {
      chunks.push(c);
      total += c.length;
    });
    let stderr = "";
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `ffmpeg exited with code ${code ?? "?"}: ${stderr.trim() || "(no stderr)"}`,
          ),
        );
        return;
      }
      // Concat into a fresh, 4-byte-aligned ArrayBuffer so Float32Array can
      // view it directly (Buffer.concat's underlying ArrayBuffer is not
      // guaranteed to be aligned).
      const ab = new ArrayBuffer(total);
      const u8 = new Uint8Array(ab);
      let offset = 0;
      for (const c of chunks) {
        u8.set(c, offset);
        offset += c.length;
      }
      resolve(new Float32Array(ab));
    });
  });
}

/**
 * Map our short Whisper model names to HuggingFace model IDs that publish
 * ONNX weights compatible with @huggingface/transformers.
 *
 * Xenova hosts ONNX exports at huggingface.co/Xenova/whisper-* for the
 * standard sizes; the v3-class models live under onnx-community.
 *
 * `large-v1` has no ONNX export — we fall back to `large-v3`, which is the
 * current best "large" available in the JS runtime.
 */
function toHuggingFaceModelId(model: WhisperModel): string {
  switch (model) {
    case "tiny":
      return "Xenova/whisper-tiny";
    case "tiny.en":
      return "Xenova/whisper-tiny.en";
    case "base":
      return "Xenova/whisper-base";
    case "base.en":
      return "Xenova/whisper-base.en";
    case "small":
      return "Xenova/whisper-small";
    case "small.en":
      return "Xenova/whisper-small.en";
    case "medium":
      return "Xenova/whisper-medium";
    case "medium.en":
      return "Xenova/whisper-medium.en";
    case "large-v1":
    case "large":
      return "onnx-community/whisper-large-v3";
    case "large-v3-turbo":
      return "onnx-community/whisper-large-v3-turbo";
  }
}

function isEnglishOnly(model: WhisperModel): boolean {
  return model.endsWith(".en");
}

type AsrPipeline = (
  audio: Float32Array,
  options?: Record<string, unknown>,
) => Promise<{ text?: string }>;

let pipelineCache: { id: string; promise: Promise<AsrPipeline> } | null = null;

async function getPipeline(modelId: string): Promise<AsrPipeline> {
  if (pipelineCache && pipelineCache.id === modelId) {
    return pipelineCache.promise;
  }
  const promise = (async () => {
    const { pipeline } = await import("@huggingface/transformers");
    const p = await pipeline("automatic-speech-recognition", modelId);
    return p as unknown as AsrPipeline;
  })();
  pipelineCache = { id: modelId, promise };
  // Drop the cache on failure so the next call retries the load instead of
  // returning the rejected promise forever.
  promise.catch(() => {
    if (pipelineCache && pipelineCache.id === modelId) {
      pipelineCache = null;
    }
  });
  return promise;
}

export async function transcribeAudio(
  opts: TranscribeOptions,
): Promise<TranscribeResult> {
  const ffmpegPath = await resolveFfmpegPath(opts.ffmpegPath);

  const tDecode = Date.now();
  const audio = await decodeToFloat32(ffmpegPath, opts.inputPath);
  const decodeMs = Date.now() - tDecode;

  // Snapshot cache state BEFORE getPipeline mutates it, so we can tell
  // whether this call paid the cold-start cost or rode an existing entry.
  const modelId = toHuggingFaceModelId(opts.model);
  const pipelineCached = pipelineCache?.id === modelId;

  const tPipe = Date.now();
  const transcriber = await getPipeline(modelId);
  const pipelineMs = Date.now() - tPipe;

  // .en models only know English — they reject `language` / `task` flags.
  // Multilingual models accept them and benefit from the language hint.
  const inferenceOpts: Record<string, unknown> = {
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: false,
  };
  if (!isEnglishOnly(opts.model)) {
    inferenceOpts.task = "transcribe";
    if (opts.language) {
      inferenceOpts.language = opts.language;
    }
  }

  const tInfer = Date.now();
  const result = await transcriber(audio, inferenceOpts);
  const inferMs = Date.now() - tInfer;
  const text = (result.text ?? "").trim();
  return {
    text,
    timings: { decodeMs, pipelineMs, pipelineCached, inferMs },
  };
}

/**
 * Pre-warm the transformers.js whisper pipeline. First call downloads ONNX
 * weights into the HuggingFace cache; subsequent calls are no-ops.
 */
export async function ensureWhisperModel(model: WhisperModel): Promise<void> {
  await getPipeline(toHuggingFaceModelId(model));
}

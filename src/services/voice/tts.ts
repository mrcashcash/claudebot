/**
 * Text-to-speech for Claude's reply. Currently OpenAI-only — the simplest
 * cloud backend that returns Telegram-compatible Ogg/Opus directly.
 *
 * Why cloud here when transcription is local? Quality. Whisper-cpp's accuracy
 * on short voice notes is good enough; offline TTS at comparable quality
 * needs a sizable model + GPU. The user can opt out by leaving
 * voice.tts.enabled=false (the default).
 */

export type TtsBackend = "openai";
export type TtsFormat = "opus" | "mp3";

export interface TtsConfig {
  enabled: boolean;
  backend: TtsBackend;
  /** Backend model id. OpenAI: "tts-1", "tts-1-hd", "gpt-4o-mini-tts". */
  model: string;
  /** Backend voice id. OpenAI: alloy/echo/fable/onyx/nova/shimmer + others. */
  voice: string;
  /** Audio container/codec. Telegram voice messages need ogg/opus. */
  format: TtsFormat;
  /**
   * Skip synthesis when the reply text exceeds this many chars. OpenAI's
   * limit is 4096 — over that, we send the text reply as usual and skip TTS.
   */
  maxChars: number;
}

export interface TtsResult {
  audio: Buffer;
  format: TtsFormat;
}

const OPENAI_TTS_URL = "https://api.openai.com/v1/audio/speech";
const OPENAI_HARD_LIMIT = 4096;

export class TtsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TtsConfigError";
  }
}

/**
 * Synthesize `text` per `cfg`. Returns the encoded audio bytes.
 * Throws TtsConfigError if the backend isn't configured (e.g. missing
 * OPENAI_API_KEY) — callers should treat that as "skip and fall back to text"
 * rather than user-facing failure.
 */
export async function synthesize(
  text: string,
  cfg: TtsConfig,
): Promise<TtsResult> {
  if (!cfg.enabled) {
    throw new TtsConfigError("voice.tts.enabled is false");
  }
  if (cfg.backend !== "openai") {
    throw new TtsConfigError(`unknown TTS backend: ${cfg.backend}`);
  }
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new TtsConfigError("OPENAI_API_KEY is not set");
  }
  if (text.length > OPENAI_HARD_LIMIT) {
    throw new TtsConfigError(
      `text exceeds OpenAI ${OPENAI_HARD_LIMIT}-char TTS limit (${text.length})`,
    );
  }

  const r = await fetch(OPENAI_TTS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.model,
      input: text,
      voice: cfg.voice,
      response_format: cfg.format,
    }),
  });
  if (!r.ok) {
    const errBody = await r.text().catch(() => "");
    throw new Error(`OpenAI TTS ${r.status}: ${errBody.slice(0, 500)}`);
  }
  const ab = await r.arrayBuffer();
  return { audio: Buffer.from(ab), format: cfg.format };
}

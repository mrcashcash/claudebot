import {
  VALID_PERMISSION_MODES,
  VALID_VOICE_REPLY_MODES,
  VALID_WHISPER_MODELS,
  type PermissionMode,
  type TtsConfig,
  type VoiceConfig,
  type VoiceReplyMode,
  type WhisperModel,
} from "./config.ts";

export function parseBool(
  raw: unknown,
  fallback: boolean,
): boolean {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === "boolean") return raw;
  const v = String(raw).trim().toLowerCase();
  if (v === "") return fallback;
  if (["1", "true", "yes", "y", "on"].includes(v)) return true;
  if (["0", "false", "no", "n", "off"].includes(v)) return false;
  throw new Error(`Expected boolean (true/false), got: ${String(raw)}`);
}

export function parsePermissionMode(raw: unknown): PermissionMode {
  const v = (typeof raw === "string" ? raw.trim() : "") || "acceptEdits";
  if (!VALID_PERMISSION_MODES.has(v as PermissionMode)) {
    throw new Error(
      `permissionMode must be one of ${[...VALID_PERMISSION_MODES].join(", ")}`,
    );
  }
  return v as PermissionMode;
}

export function parseWhisperModel(raw: unknown): WhisperModel {
  const v = (typeof raw === "string" ? raw.trim() : "") || "base.en";
  if (!VALID_WHISPER_MODELS.has(v as WhisperModel)) {
    throw new Error(
      `whisperModel must be one of ${[...VALID_WHISPER_MODELS].join(", ")}`,
    );
  }
  return v as WhisperModel;
}

export function parseVoiceReplyMode(raw: unknown): VoiceReplyMode {
  const v = (typeof raw === "string" ? raw.trim() : "") || "text";
  if (!VALID_VOICE_REPLY_MODES.has(v as VoiceReplyMode)) {
    throw new Error(
      `voice.replyMode must be one of ${[...VALID_VOICE_REPLY_MODES].join(", ")}`,
    );
  }
  return v as VoiceReplyMode;
}

export function parseTtsFormat(raw: unknown): "opus" | "mp3" {
  const v = (typeof raw === "string" ? raw.trim().toLowerCase() : "") || "opus";
  if (v !== "opus" && v !== "mp3") {
    throw new Error(`voice.tts.format must be "opus" or "mp3"; got: ${String(raw)}`);
  }
  return v;
}

export function parseLanguage(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const v = String(raw).trim();
  if (v === "" || v === "auto") return undefined;
  if (!/^[a-z]{2}$/.test(v)) {
    throw new Error(
      `language must be a 2-letter ISO 639-1 code (e.g. en, he, es) or "auto"; got: ${String(raw)}`,
    );
  }
  return v;
}

export function parsePositiveInt(
  raw: unknown,
  fallback: number,
  name: string,
): number {
  if (raw === undefined || raw === null) return fallback;
  const s = String(raw).trim();
  if (s === "") return fallback;
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer; got: ${String(raw)}`);
  }
  return n;
}

/**
 * Voice config as it's stored on disk: every field optional, including a
 * partial TTS sub-config. `voiceFor` in users.ts merges this with defaults
 * to produce a fully-resolved VoiceConfig at read time.
 */
export interface UserVoiceConfig
  extends Partial<Omit<VoiceConfig, "tts">> {
  tts?: Partial<TtsConfig>;
}

export interface UserConfig {
  workspaceDir?: string;
  permissionMode?: PermissionMode;
  /** SDK model id, e.g. "claude-opus-4-7". Empty/absent = SDK default. */
  model?: string;
  voice?: UserVoiceConfig;
  /** IANA tz, e.g. "Asia/Jerusalem". */
  tz?: string;
  name?: string;
  notes?: string;
}

function pickString(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  return v === "" ? undefined : v;
}

/**
 * Validate a parsed JSON blob into a UserConfig. Throws on bad shape.
 * Missing fields stay missing — defaults are applied at read time by users.ts
 * (effectiveWorkspace/effectiveMode/voiceFor/tzFor) so a single edit to the
 * file doesn't have to spell out every key.
 */
export function validateUserConfig(raw: unknown): UserConfig {
  if (raw === null || typeof raw !== "object") {
    throw new Error("user config must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const out: UserConfig = {};

  const workspaceDir = pickString(obj.workspaceDir);
  if (workspaceDir) out.workspaceDir = workspaceDir;

  if (obj.permissionMode !== undefined && obj.permissionMode !== "") {
    out.permissionMode = parsePermissionMode(obj.permissionMode);
  }

  const model = pickString(obj.model);
  if (model) out.model = model;

  const tz = pickString(obj.tz);
  if (tz) out.tz = tz;

  const name = pickString(obj.name);
  if (name) out.name = name;

  const notes = pickString(obj.notes);
  if (notes) out.notes = notes;

  if (obj.voice !== undefined && obj.voice !== null) {
    if (typeof obj.voice !== "object") {
      throw new Error("voice must be an object");
    }
    const v = obj.voice as Record<string, unknown>;
    const voice: UserVoiceConfig = {};
    if (v.enabled !== undefined) voice.enabled = parseBool(v.enabled, true);
    if (v.whisperModel !== undefined && v.whisperModel !== "") {
      voice.whisperModel = parseWhisperModel(v.whisperModel);
    }
    if (v.language !== undefined) {
      voice.language = parseLanguage(v.language);
    }
    const ffmpegPath = pickString(v.ffmpegPath);
    if (ffmpegPath) voice.ffmpegPath = ffmpegPath;
    if (v.preloadModel !== undefined) {
      voice.preloadModel = parseBool(v.preloadModel, false);
    }
    if (v.maxDurationSec !== undefined && v.maxDurationSec !== "") {
      voice.maxDurationSec = parsePositiveInt(
        v.maxDurationSec,
        600,
        "voice.maxDurationSec",
      );
    }
    if (v.replyMode !== undefined && v.replyMode !== "") {
      voice.replyMode = parseVoiceReplyMode(v.replyMode);
    }
    if (v.tts !== undefined && v.tts !== null) {
      if (typeof v.tts !== "object") {
        throw new Error("voice.tts must be an object");
      }
      const t = v.tts as Record<string, unknown>;
      const tts: Partial<TtsConfig> = {};
      if (t.enabled !== undefined) tts.enabled = parseBool(t.enabled, false);
      if (t.backend !== undefined && t.backend !== "") {
        if (t.backend !== "openai") {
          throw new Error(`voice.tts.backend must be "openai"; got: ${String(t.backend)}`);
        }
        tts.backend = "openai";
      }
      const ttsModel = pickString(t.model);
      if (ttsModel) tts.model = ttsModel;
      const ttsVoice = pickString(t.voice);
      if (ttsVoice) tts.voice = ttsVoice;
      if (t.format !== undefined && t.format !== "") {
        tts.format = parseTtsFormat(t.format);
      }
      if (t.maxChars !== undefined && t.maxChars !== "") {
        tts.maxChars = parsePositiveInt(t.maxChars, 4000, "voice.tts.maxChars");
      }
      if (Object.keys(tts).length > 0) voice.tts = tts;
    }
    if (Object.keys(voice).length > 0) out.voice = voice;
  }

  return out;
}

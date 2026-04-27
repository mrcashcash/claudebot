import {
  VALID_PERMISSION_MODES,
  VALID_WHISPER_MODELS,
  type PermissionMode,
  type VoiceConfig,
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

export interface UserConfig {
  workspaceDir?: string;
  permissionMode?: PermissionMode;
  /** SDK model id, e.g. "claude-opus-4-7". Empty/absent = SDK default. */
  model?: string;
  voice?: Partial<VoiceConfig>;
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
    const voice: Partial<VoiceConfig> = {};
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
    if (Object.keys(voice).length > 0) out.voice = voice;
  }

  return out;
}

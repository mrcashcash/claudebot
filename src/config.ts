import path from "node:path";

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

// Mirrors the model names supported by nodejs-whisper's MODEL_OBJECT.
// Keep in sync with node_modules/nodejs-whisper/dist/constants.d.ts.
export type WhisperModel =
  | "tiny"
  | "tiny.en"
  | "base"
  | "base.en"
  | "small"
  | "small.en"
  | "medium"
  | "medium.en"
  | "large-v1"
  | "large"
  | "large-v3-turbo";

export interface VoiceConfig {
  enabled: boolean;
  whisperModel: WhisperModel;
  /** ISO 639-1 hint, e.g. "en", "he". `undefined` means auto-detect. */
  language: string | undefined;
  /** Override path to ffmpeg binary. `undefined` uses bundled ffmpeg-static. */
  ffmpegPath: string | undefined;
  /** Download the model at boot so the first voice message is fast. */
  preloadModel: boolean;
  /** Telegram voice messages longer than this are rejected. */
  maxDurationSec: number;
}

export interface Config {
  telegramBotToken: string;
  allowedUserIds: Set<number>;
  workspaceDir: string;
  permissionMode: PermissionMode;
  authMode: "oauth-token" | "subscription-login";
  voice: VoiceConfig;
}

export const VALID_PERMISSION_MODES: ReadonlySet<PermissionMode> = new Set([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
]);

export const VALID_WHISPER_MODELS: ReadonlySet<WhisperModel> = new Set([
  "tiny",
  "tiny.en",
  "base",
  "base.en",
  "small",
  "small.en",
  "medium",
  "medium.en",
  "large-v1",
  "large",
  "large-v3-turbo",
]);

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var ${name}`);
  }
  return v.trim();
}

function parseUserIds(raw: string): Set<number> {
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const n = Number(s);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`ALLOWED_TELEGRAM_USER_IDS contains non-numeric value: ${s}`);
      }
      return n;
    });
  if (ids.length === 0) {
    throw new Error("ALLOWED_TELEGRAM_USER_IDS must contain at least one ID");
  }
  return new Set(ids);
}

function parsePermissionMode(raw: string | undefined): PermissionMode {
  const v = (raw?.trim() || "acceptEdits") as PermissionMode;
  if (!VALID_PERMISSION_MODES.has(v)) {
    throw new Error(
      `CLAUDE_PERMISSION_MODE must be one of ${[...VALID_PERMISSION_MODES].join(", ")}`,
    );
  }
  return v;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  const v = raw?.trim().toLowerCase();
  if (v === undefined || v === "") return fallback;
  if (["1", "true", "yes", "y", "on"].includes(v)) return true;
  if (["0", "false", "no", "n", "off"].includes(v)) return false;
  throw new Error(`Expected boolean (true/false), got: ${raw}`);
}

function parseWhisperModel(raw: string | undefined): WhisperModel {
  const v = (raw?.trim() || "base.en") as WhisperModel;
  if (!VALID_WHISPER_MODELS.has(v)) {
    throw new Error(
      `WHISPER_MODEL must be one of ${[...VALID_WHISPER_MODELS].join(", ")}`,
    );
  }
  return v;
}

function parseLanguage(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  if (v === undefined || v === "") return undefined;
  if (v === "auto") return undefined;
  if (!/^[a-z]{2}$/.test(v)) {
    throw new Error(
      `WHISPER_LANGUAGE must be a 2-letter ISO 639-1 code (e.g. en, he, es) or "auto"; got: ${raw}`,
    );
  }
  return v;
}

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  const v = raw?.trim();
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer; got: ${raw}`);
  }
  return n;
}

function loadVoiceConfig(): VoiceConfig {
  return {
    enabled: parseBool(process.env.VOICE_ENABLED, true),
    whisperModel: parseWhisperModel(process.env.WHISPER_MODEL),
    language: parseLanguage(process.env.WHISPER_LANGUAGE),
    ffmpegPath: process.env.FFMPEG_PATH?.trim() || undefined,
    preloadModel: parseBool(process.env.WHISPER_PRELOAD, false),
    maxDurationSec: parsePositiveInt(
      process.env.VOICE_MAX_DURATION_SEC,
      600,
      "VOICE_MAX_DURATION_SEC",
    ),
  };
}

export function loadConfig(): Config {
  const telegramBotToken = required("TELEGRAM_BOT_TOKEN");
  const allowedUserIds = parseUserIds(required("ALLOWED_TELEGRAM_USER_IDS"));
  const workspaceDir = path.resolve(
    process.env.CLAUDE_WORKSPACE_DIR?.trim() || process.cwd(),
  );
  const permissionMode = parsePermissionMode(process.env.CLAUDE_PERMISSION_MODE);
  const authMode: Config["authMode"] = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()
    ? "oauth-token"
    : "subscription-login";
  const voice = loadVoiceConfig();
  return {
    telegramBotToken,
    allowedUserIds,
    workspaceDir,
    permissionMode,
    authMode,
    voice,
  };
}

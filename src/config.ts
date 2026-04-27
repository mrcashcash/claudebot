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
  /**
   * Directory the bot's own source lives in (captured from process.cwd() at
   * boot, before anything has chdir'd). Used as the implicit fallback when a
   * user's `workspaceDir` is unset, and always added to the SDK's
   * additionalDirectories so `<gatewayDir>/.claude/skills/` loads even when a
   * user has overridden their workspace to somewhere else.
   */
  gatewayDir: string;
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

export function loadConfig(): Config {
  const telegramBotToken = required("TELEGRAM_BOT_TOKEN");
  const allowedUserIds = parseUserIds(required("ALLOWED_TELEGRAM_USER_IDS"));
  const gatewayDir = path.resolve(process.cwd());
  return {
    telegramBotToken,
    allowedUserIds,
    gatewayDir,
  };
}

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

export type VoiceReplyMode = "text" | "voice" | "auto";

export interface TtsConfig {
  enabled: boolean;
  backend: "openai";
  /** Backend model id, e.g. "tts-1" / "tts-1-hd" / "gpt-4o-mini-tts". */
  model: string;
  /** Backend voice id, e.g. "alloy" / "nova" / "shimmer". */
  voice: string;
  /** Container/codec; Telegram voice messages need ogg/opus. */
  format: "opus" | "mp3";
  /** Skip synthesis when the reply text exceeds this many chars. */
  maxChars: number;
}

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
  /**
   * When to send Claude's reply as a voice message.
   * - "text" (default): never; always reply with text only.
   * - "voice": always synthesize the reply (in addition to the text message).
   * - "auto": synthesize only when the user's input was a voice message.
   */
  replyMode: VoiceReplyMode;
  /** TTS backend config. Only consulted when replyMode triggers a synth. */
  tts: TtsConfig;
}

export const VALID_VOICE_REPLY_MODES: ReadonlySet<VoiceReplyMode> = new Set([
  "text",
  "voice",
  "auto",
]);

export interface SlackConfig {
  /** Bot token (xoxb-…). */
  botToken: string;
  /** App-level token with `connections:write` for Socket Mode (xapp-…). */
  appToken: string;
  /** Slack user IDs (U…) allowed to talk to the bot. */
  allowedUserIds: Set<string>;
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
  /** Optional Slack transport. Absent (undefined) means Slack is disabled and
   *  the bot runs Telegram-only. Present means we also start a Slack Bolt
   *  app in Socket Mode at boot. */
  slack?: SlackConfig;
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

function parseSlackConfig(): SlackConfig | undefined {
  const botToken = process.env.SLACK_BOT_TOKEN?.trim();
  const appToken = process.env.SLACK_APP_TOKEN?.trim();
  const allowedRaw = process.env.ALLOWED_SLACK_USER_IDS?.trim();
  // All three must be present together. If any are missing, leave Slack off.
  if (!botToken || !appToken || !allowedRaw) return undefined;
  const allowedUserIds = new Set(
    allowedRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
  if (allowedUserIds.size === 0) {
    throw new Error("ALLOWED_SLACK_USER_IDS must contain at least one Slack user id");
  }
  return { botToken, appToken, allowedUserIds };
}

export function loadConfig(): Config {
  const telegramBotToken = required("TELEGRAM_BOT_TOKEN");
  const allowedUserIds = parseUserIds(required("ALLOWED_TELEGRAM_USER_IDS"));
  const gatewayDir = path.resolve(process.cwd());
  const slack = parseSlackConfig();
  return {
    telegramBotToken,
    allowedUserIds,
    gatewayDir,
    ...(slack ? { slack } : {}),
  };
}

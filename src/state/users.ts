import fs from "node:fs/promises";
import path from "node:path";
import type {
  PermissionMode,
  TtsConfig,
  VoiceConfig,
  VoiceReplyMode,
  WhisperModel,
} from "../config.ts";
import {
  validateUserConfig,
  type UserConfig,
} from "../configValidate.ts";
import * as sessions from "./sessions.ts";
import * as store from "./store.ts";
import { logError } from "./logger.ts";

export type { UserConfig } from "../configValidate.ts";

const TEMPLATE = path.join(process.cwd(), "userTemplate.json");
const DEFAULT_TZ = "Asia/Jerusalem";
const DEFAULT_PERMISSION_MODE: PermissionMode = "acceptEdits";

const TTS_DEFAULTS: TtsConfig = {
  enabled: false,
  backend: "openai",
  model: "tts-1",
  voice: "alloy",
  format: "opus",
  maxChars: 4000,
};

const VOICE_DEFAULTS: VoiceConfig = {
  enabled: true,
  whisperModel: "base.en" satisfies WhisperModel as WhisperModel,
  language: undefined,
  ffmpegPath: undefined,
  preloadModel: false,
  maxDurationSec: 600,
  replyMode: "text" satisfies VoiceReplyMode as VoiceReplyMode,
  tts: TTS_DEFAULTS,
};

let loaded = false;

/**
 * No-op assertion — actual hydration happens in `store.load()` (called first
 * by `index.ts`). Kept so the existing bootstrap order in index.ts continues
 * to read naturally.
 */
export async function load(): Promise<void> {
  loaded = true;
}

function assertLoaded(): void {
  if (!loaded) throw new Error("users.load() must be called before use");
}

/** Stringify any user id so the same key works for Telegram numerics and Slack "U…". */
function key(userId: number | string): string {
  return String(userId);
}

export function get(userId: number | string): UserConfig | undefined {
  assertLoaded();
  return store.getUsers()[key(userId)];
}

export function has(userId: number | string): boolean {
  assertLoaded();
  return store.getUsers()[key(userId)] !== undefined;
}

export function allUserIds(): string[] {
  assertLoaded();
  return Object.keys(store.getUsers());
}

async function readTemplate(): Promise<string> {
  try {
    return await fs.readFile(TEMPLATE, "utf8");
  } catch {
    // Template missing — fall back to a minimal default. The bot still runs.
    return JSON.stringify(
      {
        name: "",
        notes: "Edit me — Claude can too. Auto-reloaded on save.",
        workspaceDir: "",
        permissionMode: "acceptEdits",
        model: "",
        tz: DEFAULT_TZ,
        voice: {
          enabled: true,
          whisperModel: "base.en",
          language: "en",
          preloadModel: false,
          maxDurationSec: 600,
        },
      },
      null,
      2,
    );
  }
}

/**
 * Write a default config for the user if none exists. Returns true if we
 * actually created the entry, false if it was already present.
 */
export async function ensure(userId: number | string): Promise<boolean> {
  assertLoaded();
  const users = store.getUsers();
  const k = key(userId);
  if (users[k]) return false;
  const raw = await readTemplate();
  try {
    users[k] = validateUserConfig(JSON.parse(raw));
  } catch (err) {
    void logError("error.user_template", err, { userId });
    console.warn(
      `[users] template was invalid for user ${userId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    users[k] = {};
  }
  await store.persist();
  console.log(`[users] created default config for user ${userId}`);
  return true;
}

export async function update(
  userId: number | string,
  patch: Partial<UserConfig>,
): Promise<void> {
  assertLoaded();
  const users = store.getUsers();
  const k = key(userId);
  const current = users[k] ?? {};
  // Merge: undefined in `patch` clears the field; otherwise overrides.
  const next: UserConfig = { ...current };
  for (const fk of Object.keys(patch) as (keyof UserConfig)[]) {
    const v = patch[fk];
    if (v === undefined) {
      delete next[fk];
    } else {
      // Deliberate any-cast: TS can't narrow Partial<UserConfig> per-key here.
      (next as Record<string, unknown>)[fk] = v;
    }
  }
  users[k] = next;
  await store.persist();
}

export function voiceFor(userId: number | string): VoiceConfig {
  const u = store.getUsers()[key(userId)];
  const v = u?.voice ?? {};
  const tIn = v.tts ?? {};
  const tts: TtsConfig = {
    enabled: tIn.enabled ?? TTS_DEFAULTS.enabled,
    backend: tIn.backend ?? TTS_DEFAULTS.backend,
    model: tIn.model ?? TTS_DEFAULTS.model,
    voice: tIn.voice ?? TTS_DEFAULTS.voice,
    format: tIn.format ?? TTS_DEFAULTS.format,
    maxChars: tIn.maxChars ?? TTS_DEFAULTS.maxChars,
  };
  return {
    enabled: v.enabled ?? VOICE_DEFAULTS.enabled,
    whisperModel: v.whisperModel ?? VOICE_DEFAULTS.whisperModel,
    language: v.language ?? VOICE_DEFAULTS.language,
    ffmpegPath: v.ffmpegPath ?? VOICE_DEFAULTS.ffmpegPath,
    preloadModel: v.preloadModel ?? VOICE_DEFAULTS.preloadModel,
    maxDurationSec: v.maxDurationSec ?? VOICE_DEFAULTS.maxDurationSec,
    replyMode: v.replyMode ?? VOICE_DEFAULTS.replyMode,
    tts,
  };
}

/**
 * Resolve the effective workspace for a turn. Layered chat → user → gateway:
 * a per-chat override (set in groups via /workspace) wins, falling back to the
 * user's default, falling back to the gateway directory.
 */
export function effectiveWorkspace(
  chatId: number | string,
  userId: number | string,
  gatewayDir: string,
): string {
  const chatOverride = sessions.get(chatId).workspaceDir;
  if (chatOverride) return chatOverride;
  return store.getUsers()[key(userId)]?.workspaceDir ?? gatewayDir;
}

export function effectiveMode(
  chatId: number | string,
  userId: number | string,
): PermissionMode {
  const chatOverride = sessions.get(chatId).permissionMode;
  if (chatOverride) return chatOverride;
  return (
    store.getUsers()[key(userId)]?.permissionMode ?? DEFAULT_PERMISSION_MODE
  );
}

/**
 * Resolved model id for the turn (chat override → user default → undefined =
 * SDK default). Empty strings are treated as unset.
 */
export function effectiveModel(
  chatId: number | string,
  userId: number | string,
): string | undefined {
  const chatOverride = sessions.get(chatId).model;
  if (chatOverride) return chatOverride;
  const u = store.getUsers()[key(userId)]?.model;
  return u && u.length > 0 ? u : undefined;
}

export function tzFor(userId: number | string): string {
  return store.getUsers()[key(userId)]?.tz ?? DEFAULT_TZ;
}

export function watch(): void {
  store.watch();
}

export function stopWatch(): void {
  store.stopWatch();
}

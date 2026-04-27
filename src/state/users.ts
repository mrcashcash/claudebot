import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import type { PermissionMode, VoiceConfig, WhisperModel } from "../config.ts";
import {
  validateUserConfig,
  type UserConfig,
} from "../configValidate.ts";
import * as sessions from "./sessions.ts";

export type { UserConfig } from "../configValidate.ts";

const USERS_DIR = path.join(process.cwd(), "data", "users");
const TEMPLATE = path.join(process.cwd(), "userTemplate.json");
const DEFAULT_TZ = "Asia/Jerusalem";
const DEFAULT_PERMISSION_MODE: PermissionMode = "acceptEdits";

const VOICE_DEFAULTS: VoiceConfig = {
  enabled: true,
  whisperModel: "base.en" satisfies WhisperModel as WhisperModel,
  language: undefined,
  ffmpegPath: undefined,
  preloadModel: false,
  maxDurationSec: 600,
};

const cache = new Map<number, UserConfig>();
/** mtime in ms of the last self-write per user — lets watch() ignore the echo. */
const selfWriteMtime = new Map<number, number>();
let loaded = false;
let watcher: fsSync.FSWatcher | null = null;
let watchTimer: NodeJS.Timeout | null = null;

async function ensureDir(): Promise<void> {
  await fs.mkdir(USERS_DIR, { recursive: true });
}

function fileFor(userId: number): string {
  return path.join(USERS_DIR, `${userId}.json`);
}

function userIdFromFilename(name: string): number | null {
  const m = name.match(/^(\d+)\.json$/);
  if (!m || !m[1]) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function readOne(userId: number): Promise<UserConfig | null> {
  try {
    const raw = await fs.readFile(fileFor(userId), "utf8");
    const parsed = JSON.parse(raw);
    return validateUserConfig(parsed);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    console.warn(
      `[users] failed to read user ${userId}: ${err instanceof Error ? err.message : String(err)} — keeping previous cache value`,
    );
    return null;
  }
}

export async function load(): Promise<void> {
  await ensureDir();
  cache.clear();
  let entries: string[] = [];
  try {
    entries = await fs.readdir(USERS_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  for (const name of entries) {
    const userId = userIdFromFilename(name);
    if (userId === null) continue;
    const cfg = await readOne(userId);
    if (cfg) cache.set(userId, cfg);
  }
  loaded = true;
}

function assertLoaded(): void {
  if (!loaded) throw new Error("users.load() must be called before use");
}

export function get(userId: number): UserConfig | undefined {
  assertLoaded();
  return cache.get(userId);
}

export function has(userId: number): boolean {
  assertLoaded();
  return cache.has(userId);
}

export function allUserIds(): number[] {
  assertLoaded();
  return [...cache.keys()];
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

async function persistRaw(userId: number, raw: string): Promise<void> {
  await ensureDir();
  const dest = fileFor(userId);
  const tmp = dest + ".tmp";
  await fs.writeFile(tmp, raw, "utf8");
  await fs.rename(tmp, dest);
  try {
    const stat = await fs.stat(dest);
    selfWriteMtime.set(userId, stat.mtimeMs);
  } catch {
    // ignore
  }
}

/**
 * Write a default config for the user if none exists. Returns true if we
 * actually created the file, false if it was already present. Cheap fast-path
 * via the in-memory cache; falls back to disk to be safe across watcher races.
 */
export async function ensure(userId: number): Promise<boolean> {
  assertLoaded();
  if (cache.has(userId)) return false;
  const onDisk = await readOne(userId);
  if (onDisk) {
    cache.set(userId, onDisk);
    return false;
  }
  const raw = await readTemplate();
  await persistRaw(userId, raw);
  try {
    cache.set(userId, validateUserConfig(JSON.parse(raw)));
  } catch (err) {
    console.warn(
      `[users] template was invalid for user ${userId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    cache.set(userId, {});
  }
  console.log(`[users] created default config for user ${userId}`);
  return true;
}

export async function update(
  userId: number,
  patch: Partial<UserConfig>,
): Promise<void> {
  assertLoaded();
  const current = cache.get(userId) ?? {};
  // Merge: undefined in `patch` clears the field; otherwise overrides.
  const next: UserConfig = { ...current };
  for (const k of Object.keys(patch) as (keyof UserConfig)[]) {
    const v = patch[k];
    if (v === undefined) {
      delete next[k];
    } else {
      // Deliberate any-cast: TS can't narrow Partial<UserConfig> per-key here.
      (next as Record<string, unknown>)[k] = v;
    }
  }
  const raw = JSON.stringify(next, null, 2);
  await persistRaw(userId, raw);
  cache.set(userId, next);
}

export function voiceFor(userId: number): VoiceConfig {
  const u = cache.get(userId);
  const v = u?.voice ?? {};
  return {
    enabled: v.enabled ?? VOICE_DEFAULTS.enabled,
    whisperModel: v.whisperModel ?? VOICE_DEFAULTS.whisperModel,
    language: v.language ?? VOICE_DEFAULTS.language,
    ffmpegPath: v.ffmpegPath ?? VOICE_DEFAULTS.ffmpegPath,
    preloadModel: v.preloadModel ?? VOICE_DEFAULTS.preloadModel,
    maxDurationSec: v.maxDurationSec ?? VOICE_DEFAULTS.maxDurationSec,
  };
}

/**
 * Resolve the effective workspace for a turn. Layered chat → user → gateway:
 * a per-chat override (set in groups via /workspace) wins, falling back to the
 * user's default, falling back to the gateway directory. This is what makes
 * each Telegram group remember its own workspace independently.
 */
export function effectiveWorkspace(
  chatId: number | string,
  userId: number,
  gatewayDir: string,
): string {
  const chatOverride = sessions.get(chatId).workspaceDir;
  if (chatOverride) return chatOverride;
  return cache.get(userId)?.workspaceDir ?? gatewayDir;
}

export function effectiveMode(
  chatId: number | string,
  userId: number,
): PermissionMode {
  const chatOverride = sessions.get(chatId).permissionMode;
  if (chatOverride) return chatOverride;
  return cache.get(userId)?.permissionMode ?? DEFAULT_PERMISSION_MODE;
}

/**
 * Resolved model id for the turn (chat override → user default → undefined =
 * SDK default). Empty strings are treated as unset so users can clear by
 * writing "" in the JSON.
 */
export function effectiveModel(
  chatId: number | string,
  userId: number,
): string | undefined {
  const chatOverride = sessions.get(chatId).model;
  if (chatOverride) return chatOverride;
  const u = cache.get(userId)?.model;
  return u && u.length > 0 ? u : undefined;
}

export function tzFor(userId: number): string {
  return cache.get(userId)?.tz ?? DEFAULT_TZ;
}

async function rescan(): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(USERS_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(
        `[users] watcher rescan failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }
  const seen = new Set<number>();
  for (const name of entries) {
    const userId = userIdFromFilename(name);
    if (userId === null) continue;
    seen.add(userId);
    let mtimeMs: number | undefined;
    try {
      const stat = await fs.stat(fileFor(userId));
      mtimeMs = stat.mtimeMs;
    } catch {
      continue;
    }
    // Skip our own writes.
    const ours = selfWriteMtime.get(userId);
    if (ours !== undefined && Math.abs(ours - (mtimeMs ?? 0)) < 1) continue;
    const cfg = await readOne(userId);
    if (cfg) {
      cache.set(userId, cfg);
      console.log(`[users] reloaded config for user ${userId}`);
    }
  }
  // Drop users whose file disappeared.
  for (const userId of [...cache.keys()]) {
    if (!seen.has(userId)) {
      cache.delete(userId);
      selfWriteMtime.delete(userId);
      console.log(`[users] config file gone — evicted user ${userId} from cache`);
    }
  }
}

export function watch(): void {
  if (watcher) return;
  try {
    watcher = fsSync.watch(USERS_DIR, { persistent: false }, () => {
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        watchTimer = null;
        void rescan();
      }, 200);
    });
    watcher.on("error", (err) => {
      console.warn(`[users] fs.watch error: ${err.message}`);
    });
    console.log(`[users] watching ${USERS_DIR} for changes`);
  } catch (err) {
    console.warn(
      `[users] failed to start watcher: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function stopWatch(): void {
  if (watchTimer) {
    clearTimeout(watchTimer);
    watchTimer = null;
  }
  if (watcher) {
    watcher.close();
    watcher = null;
  }
}

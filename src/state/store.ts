import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import type { PermissionMode } from "../config.ts";
import { validateUserConfig, type UserConfig } from "../configValidate.ts";
import { log, logError } from "./logger.ts";

/**
 * Per-chat runtime state. Carries the active Claude session id, cumulative
 * cost, the per-tool always-allow / always-deny rules, and the optional
 * per-chat overrides for `workspaceDir` / `permissionMode` / `model` (set in
 * groups so each Telegram group has its own settings independent of the
 * user's other chats).
 */
export interface ChatState {
  sessionId?: string;
  totalCostUsd?: number;
  allowAlwaysTools?: string[];
  denyAlwaysTools?: string[];
  workspaceDir?: string;
  permissionMode?: PermissionMode;
  model?: string;
  /**
   * Group-only gate. "always" (default) responds to every message;
   * "mention" requires the bot to be @-mentioned or replied to; "reply"
   * requires a reply to a bot message. DMs ignore this and always respond.
   */
  respondTo?: "always" | "mention" | "reply";
}

export interface AppConfig {
  users: Record<string, UserConfig>;
  sessions: Record<string, ChatState>;
}

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "config.json");
const TMP = FILE + ".tmp";

const cfg: AppConfig = { users: {}, sessions: {} };
let loaded = false;
let lastSelfWriteMs = 0;
let watcher: fsSync.FSWatcher | null = null;
let watchTimer: NodeJS.Timeout | null = null;
const reloadCallbacks: Array<() => void> = [];

async function ensureDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

function assertLoaded(): void {
  if (!loaded) throw new Error("store.load() must be called before use");
}

async function readJSON(file: string): Promise<unknown> {
  const text = await fs.readFile(file, "utf8");
  return JSON.parse(text);
}

/**
 * Hydrate `cfg` from `data/config.json`. Missing file → empty cfg (a fresh
 * install starts with no users / no sessions and grows them as messages
 * arrive).
 */
export async function load(): Promise<void> {
  await ensureDir();
  let raw: unknown;
  try {
    raw = await readJSON(FILE);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      loaded = true;
      return;
    }
    throw err;
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Partial<AppConfig> & Record<string, unknown>;
    if (obj.sessions && typeof obj.sessions === "object") {
      Object.assign(cfg.sessions, obj.sessions);
    }
    if (obj.users && typeof obj.users === "object") {
      for (const [id, value] of Object.entries(obj.users as Record<string, unknown>)) {
        try {
          cfg.users[id] = validateUserConfig(value);
        } catch (err) {
          void logError("error.store_io", err, { phase: "load", userId: id });
          console.warn(
            `[store] invalid user ${id} in config.json: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }
  loaded = true;
}

export function getUsers(): Record<string, UserConfig> {
  assertLoaded();
  return cfg.users;
}

export function getSessions(): Record<string, ChatState> {
  assertLoaded();
  return cfg.sessions;
}

// Serialize all writes through a single tail Promise: concurrent callers
// (e.g. onSessionId persisting a sessionId while runTurn persists totalCostUsd)
// would otherwise race the writeFile→rename pair, with one rename hitting an
// already-renamed TMP and erroring or losing data.
let persistTail: Promise<void> = Promise.resolve();

export function persist(): Promise<void> {
  const next = persistTail.then(() => persistInternal());
  persistTail = next.catch(() => {});
  return next;
}

async function persistInternal(): Promise<void> {
  await ensureDir();
  await fs.writeFile(TMP, JSON.stringify(cfg, null, 2), "utf8");
  await fs.rename(TMP, FILE);
  try {
    const stat = await fs.stat(FILE);
    lastSelfWriteMs = stat.mtimeMs;
  } catch {
    // ignore — next external-change check will tolerate the gap
  }
  // On fresh installs the file didn't exist when watch() was first called, so
  // it deferred. Now that we've created it, retry — watch() is idempotent.
  if (!watcher) watch();
}

/**
 * Register a callback fired after an external (out-of-band) edit to
 * config.json has been re-read into the in-memory cfg. Modules that derive
 * state from cfg can use this to invalidate their own caches.
 */
export function onExternalReload(cb: () => void): void {
  reloadCallbacks.push(cb);
}

async function rescan(): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(FILE);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      void logError("error.store_io", err, { phase: "rescan_stat" });
      console.warn(
        `[store] watcher stat failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }
  // Skip our own writes — fs.watch fires for atomic rename too.
  if (Math.abs(stat.mtimeMs - lastSelfWriteMs) < 1) return;

  let raw: unknown;
  try {
    raw = await readJSON(FILE);
  } catch (err) {
    void logError("error.store_io", err, { phase: "rescan_read" });
    console.warn(
      `[store] watcher reload failed: ${err instanceof Error ? err.message : String(err)} — keeping previous in-memory state`,
    );
    return;
  }
  if (!raw || typeof raw !== "object") return;
  const obj = raw as Partial<AppConfig> & Record<string, unknown>;

  // Mutate cfg in place so callers that hold sub-references stay valid.
  for (const k of Object.keys(cfg.users)) delete cfg.users[k];
  if (obj.users && typeof obj.users === "object") {
    for (const [id, value] of Object.entries(obj.users as Record<string, unknown>)) {
      try {
        cfg.users[id] = validateUserConfig(value);
      } catch (err) {
        void logError("error.store_io", err, { phase: "rescan_validate", userId: id });
        console.warn(
          `[store] invalid user ${id} on reload: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  for (const k of Object.keys(cfg.sessions)) delete cfg.sessions[k];
  if (obj.sessions && typeof obj.sessions === "object") {
    Object.assign(cfg.sessions, obj.sessions);
  }
  console.log(`[store] reloaded ${FILE} after external change`);
  void log({
    category: "lifecycle",
    event: "lifecycle.config_reloaded",
    kind: "external_edit",
    userKeys: Object.keys(cfg.users).length,
    sessionKeys: Object.keys(cfg.sessions).length,
  });
  for (const cb of reloadCallbacks) {
    try {
      cb();
    } catch (err) {
      void logError("error.store_io", err, { phase: "reload_callback" });
      console.warn(
        `[store] reload callback threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export function watch(): void {
  if (watcher) return;
  try {
    // fs.watch on a file that doesn't exist throws on Windows, so make sure
    // the file is there. After load(), it will be (or will be created on
    // first persist()).
    watcher = fsSync.watch(FILE, { persistent: false }, () => {
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        watchTimer = null;
        void rescan();
      }, 200);
    });
    watcher.on("error", (err) => {
      void logError("error.store_io", err, { phase: "watch_error" });
      console.warn(`[store] fs.watch error: ${err.message}`);
    });
    console.log(`[store] watching ${FILE} for changes`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // No file yet (no users / no sessions ever written). The first
      // persist() will create it; we'll start the watcher then. Defer.
      console.log(
        `[store] ${FILE} not present yet — watcher will start after first write`,
      );
      return;
    }
    void logError("error.store_io", err, { phase: "watch_start" });
    console.warn(
      `[store] failed to start watcher: ${err instanceof Error ? err.message : String(err)}`,
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

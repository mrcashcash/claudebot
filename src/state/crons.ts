import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type Transport = "telegram" | "slack";

export interface Cron {
  id: string;
  /** Stringified chat id. Telegram numeric ids are stringified at the boundary; Slack ids ("C…", "D…") are already strings. */
  chatId: string;
  /** User id who created the cron — drives per-user config lookups (TZ, workspace, mode) when the cron fires. */
  userId: number | string;
  /** Which transport's `kickOffTurnFromCron` to invoke at fire time. */
  transport: Transport;
  cron: string;
  prompt: string;
  createdAt: number;
  lastFiredAt?: number;
  enabled: boolean;
  resume: boolean;
  oneShot?: boolean;
  description?: string;
}

type Store = Record<string, Cron>;

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "crons.json");
const TMP = FILE + ".tmp";

let cache: Store = {};
let loaded = false;
let lastSelfWriteMs = 0;
let watcher: fsSync.FSWatcher | null = null;
let watchTimer: NodeJS.Timeout | null = null;

async function ensureDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

/** Parse `data/crons.json` content into a Store, normalizing legacy fields. */
function parseStore(raw: unknown): Store {
  if (!raw || typeof raw !== "object") return {};
  const out: Store = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const o = value as Record<string, unknown>;
    if (
      typeof o.cron !== "string" ||
      typeof o.prompt !== "string" ||
      typeof o.enabled !== "boolean"
    )
      continue;
    if (o.userId === undefined || o.userId === null) continue;
    const chatId =
      typeof o.chatId === "number" || typeof o.chatId === "string"
        ? String(o.chatId)
        : null;
    if (!chatId) continue;
    const transport: Transport =
      o.transport === "slack" ? "slack" : "telegram";
    out[id] = {
      id,
      chatId,
      userId:
        typeof o.userId === "number" ? o.userId : String(o.userId),
      transport,
      cron: o.cron,
      prompt: o.prompt,
      createdAt: typeof o.createdAt === "number" ? o.createdAt : Date.now(),
      lastFiredAt:
        typeof o.lastFiredAt === "number" ? o.lastFiredAt : undefined,
      enabled: o.enabled,
      resume: o.resume === true,
      ...(o.oneShot === true ? { oneShot: true } : {}),
      ...(typeof o.description === "string"
        ? { description: o.description }
        : {}),
    };
  }
  return out;
}

export async function load(): Promise<void> {
  await ensureDir();
  try {
    const raw = await fs.readFile(FILE, "utf8");
    cache = parseStore(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    cache = {};
  }
  loaded = true;
  // Re-persist if migration changed anything (cheap; idempotent). Also seeds
  // lastSelfWriteMs so the watcher won't treat this write as an external edit.
  await persist();
}

function assertLoaded(): void {
  if (!loaded) throw new Error("crons.load() must be called before use");
}

async function persist(): Promise<void> {
  await ensureDir();
  await fs.writeFile(TMP, JSON.stringify(cache, null, 2), "utf8");
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

async function rescan(): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(FILE);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(
        `[crons] watcher stat failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }
  // Skip our own writes — fs.watch fires for the atomic rename too.
  if (Math.abs(stat.mtimeMs - lastSelfWriteMs) < 1) return;

  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(FILE, "utf8"));
  } catch (err) {
    console.warn(
      `[crons] watcher reload failed: ${err instanceof Error ? err.message : String(err)} — keeping previous in-memory state`,
    );
    return;
  }
  const parsed = parseStore(raw);
  // Mutate `cache` in place so any caller holding the reference stays valid.
  for (const k of Object.keys(cache)) delete cache[k];
  Object.assign(cache, parsed);
  console.log(
    `[crons] reloaded ${FILE} after external change (${Object.keys(parsed).length} rows)`,
  );
}

export function watch(): void {
  if (watcher) return;
  try {
    watcher = fsSync.watch(FILE, { persistent: false }, () => {
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        watchTimer = null;
        void rescan();
      }, 200);
    });
    watcher.on("error", (err) => {
      console.warn(`[crons] fs.watch error: ${err.message}`);
    });
    console.log(`[crons] watching ${FILE} for changes`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // File doesn't exist yet — first persist() will retry watch().
      console.log(
        `[crons] ${FILE} not present yet — watcher will start after first write`,
      );
      return;
    }
    console.warn(
      `[crons] failed to start watcher: ${err instanceof Error ? err.message : String(err)}`,
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

function freshId(): string {
  // 8-char id, base36 from random bytes; collision-safe enough for
  // human-scale fleets (<<1k crons).
  return crypto.randomBytes(6).toString("base64url").slice(0, 8);
}

export function get(id: string): Cron | undefined {
  assertLoaded();
  return cache[id];
}

export function list(chatId?: string): Cron[] {
  assertLoaded();
  const all = Object.values(cache);
  return chatId === undefined ? all : all.filter((c) => c.chatId === chatId);
}

export function allEnabled(): Cron[] {
  assertLoaded();
  return Object.values(cache).filter((c) => c.enabled);
}

export function countByChat(chatId: string): number {
  assertLoaded();
  let n = 0;
  for (const c of Object.values(cache)) if (c.chatId === chatId) n += 1;
  return n;
}

export async function create(
  input: Omit<Cron, "id" | "createdAt" | "lastFiredAt">,
): Promise<Cron> {
  assertLoaded();
  let id = freshId();
  while (cache[id]) id = freshId();
  const c: Cron = { ...input, id, createdAt: Date.now() };
  cache[id] = c;
  await persist();
  return c;
}

export async function update(
  id: string,
  patch: Partial<Omit<Cron, "id" | "createdAt">>,
): Promise<void> {
  assertLoaded();
  const existing = cache[id];
  if (!existing) return;
  cache[id] = { ...existing, ...patch };
  await persist();
}

export async function remove(id: string): Promise<boolean> {
  assertLoaded();
  if (!cache[id]) return false;
  delete cache[id];
  await persist();
  return true;
}

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export interface Cron {
  id: string;
  chatId: number;
  /** Telegram user id who created the cron — drives per-user config lookups when the cron fires. */
  userId: number;
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

async function ensureDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function load(): Promise<void> {
  await ensureDir();
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") cache = parsed as Store;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    cache = {};
  }
  // Migration: drop rows missing userId (added when configs went per-user).
  // Per-user config lookups need a userId; a row without one can't fire safely.
  let dropped = 0;
  for (const [id, c] of Object.entries(cache)) {
    if (typeof (c as Cron).userId !== "number") {
      delete cache[id];
      dropped += 1;
    }
  }
  if (dropped > 0) {
    console.warn(
      `[crons] dropped ${dropped} legacy row(s) missing userId — recreate them via /cron or by asking Claude`,
    );
    await persist();
  }
  loaded = true;
}

function assertLoaded(): void {
  if (!loaded) throw new Error("crons.load() must be called before use");
}

async function persist(): Promise<void> {
  await ensureDir();
  await fs.writeFile(TMP, JSON.stringify(cache, null, 2), "utf8");
  await fs.rename(TMP, FILE);
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

export function list(chatId?: number): Cron[] {
  assertLoaded();
  const all = Object.values(cache);
  return chatId === undefined ? all : all.filter((c) => c.chatId === chatId);
}

export function allEnabled(): Cron[] {
  assertLoaded();
  return Object.values(cache).filter((c) => c.enabled);
}

export function countByChat(chatId: number): number {
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

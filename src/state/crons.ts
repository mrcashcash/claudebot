import fs from "node:fs/promises";
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

async function ensureDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function load(): Promise<void> {
  await ensureDir();
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      // Migrate legacy rows: numeric chatId/userId → strings, missing transport → "telegram".
      const out: Store = {};
      for (const [id, raw] of Object.entries(parsed as Record<string, unknown>)) {
        if (!raw || typeof raw !== "object") continue;
        const o = raw as Record<string, unknown>;
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
          createdAt:
            typeof o.createdAt === "number" ? o.createdAt : Date.now(),
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
      cache = out;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    cache = {};
  }
  loaded = true;
  // Re-persist if migration changed anything (cheap; idempotent).
  await persist();
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

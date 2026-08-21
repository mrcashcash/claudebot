import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { Transport } from "./crons.ts";

/**
 * Watchers: the non-clock triggers. A cron fires on a schedule; a watcher fires
 * when something *changed* — a new commit, a touched path, a URL whose body
 * moved, a pattern appearing in a log. Each firing creates a background task
 * (see `watchers/ticker.ts`), so watcher-triggered work inherits budgets,
 * worktree isolation and escalation for free.
 *
 * Same atomic store shape as [crons.ts](crons.ts) and [tasks.ts](tasks.ts).
 */

export type WatcherKind = "git" | "fs" | "http" | "log";

export interface Watcher {
  id: string;
  chatId: string;
  chatKind: "dm" | "group";
  userId: number | string;
  transport: Transport;
  kind: WatcherKind;
  /**
   * What to watch. Meaning is per-kind:
   *  - git:  branch name, or "" for the workspace's current branch
   *  - fs:   absolute or workspace-relative path (file or directory)
   *  - http: URL
   *  - log:  "<path>::<regex>"
   */
  target: string;
  /** Prompt dispatched as a task when the watcher fires. */
  prompt: string;
  /** Workspace resolved at creation time — a watcher shouldn't move with /workspace. */
  workspaceDir: string;
  enabled: boolean;
  intervalSec: number;
  createdAt: number;
  lastCheckedAt?: number;
  lastFiredAt?: number;
  /** Fingerprint of the last observed state; a change is what fires. */
  lastKey?: string;
  /** Source bookkeeping (e.g. log tail offset). */
  cursor?: number;
  /** Task created by the most recent fire — used to avoid pile-ups. */
  lastTaskId?: string;
  fireCount?: number;
  /** Last error from evaluating the source, surfaced by /watch. */
  lastError?: string;
}

type Store = Record<string, Watcher>;

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "watchers.json");
const TMP = FILE + ".tmp";

export const DEFAULT_INTERVAL_SEC: Record<WatcherKind, number> = {
  git: 60,
  fs: 60,
  log: 60,
  // Polling someone else's server every minute is rude; default to 5.
  http: 300,
};

let cache: Store = {};
let loaded = false;

async function ensureDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

const KINDS: ReadonlySet<string> = new Set(["git", "fs", "http", "log"]);

function parseStore(raw: unknown): Store {
  if (!raw || typeof raw !== "object") return {};
  const out: Store = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const o = value as Record<string, unknown>;
    if (typeof o.prompt !== "string" || typeof o.kind !== "string") continue;
    if (!KINDS.has(o.kind)) continue;
    if (o.chatId === undefined || o.userId === undefined) continue;
    out[id] = {
      ...(o as unknown as Watcher),
      id,
      chatId: String(o.chatId),
      chatKind: o.chatKind === "group" ? "group" : "dm",
      transport: o.transport === "slack" ? "slack" : "telegram",
      kind: o.kind as WatcherKind,
      target: typeof o.target === "string" ? o.target : "",
      enabled: o.enabled !== false,
      intervalSec:
        typeof o.intervalSec === "number" && o.intervalSec >= 30
          ? o.intervalSec
          : DEFAULT_INTERVAL_SEC[o.kind as WatcherKind],
      workspaceDir: typeof o.workspaceDir === "string" ? o.workspaceDir : "",
      createdAt: typeof o.createdAt === "number" ? o.createdAt : Date.now(),
    };
  }
  return out;
}

export async function load(): Promise<void> {
  await ensureDir();
  try {
    cache = parseStore(JSON.parse(await fs.readFile(FILE, "utf8")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    cache = {};
  }
  loaded = true;
}

function assertLoaded(): void {
  if (!loaded) throw new Error("watchers.load() must be called before use");
}

let persistTail: Promise<void> = Promise.resolve();

export function persist(): Promise<void> {
  const next = persistTail.then(async () => {
    await ensureDir();
    await fs.writeFile(TMP, JSON.stringify(cache, null, 2), "utf8");
    await fs.rename(TMP, FILE);
  });
  persistTail = next.catch(() => {});
  return next;
}

function freshId(): string {
  return crypto.randomBytes(6).toString("base64url").slice(0, 8);
}

export function get(id: string): Watcher | undefined {
  assertLoaded();
  return cache[id];
}

export function resolve(idOrPrefix: string): Watcher | "ambiguous" | undefined {
  assertLoaded();
  const exact = cache[idOrPrefix];
  if (exact) return exact;
  const lower = idOrPrefix.toLowerCase();
  const hits = Object.values(cache).filter((w) =>
    w.id.toLowerCase().startsWith(lower),
  );
  if (hits.length === 0) return undefined;
  if (hits.length > 1) return "ambiguous";
  return hits[0];
}

export function list(chatId?: string): Watcher[] {
  assertLoaded();
  const all = Object.values(cache);
  const filtered =
    chatId === undefined ? all : all.filter((w) => w.chatId === chatId);
  return filtered.sort((a, b) => a.createdAt - b.createdAt);
}

export function allEnabled(): Watcher[] {
  assertLoaded();
  return Object.values(cache).filter((w) => w.enabled);
}

export function countByChat(chatId: string): number {
  assertLoaded();
  let n = 0;
  for (const w of Object.values(cache)) if (w.chatId === chatId) n += 1;
  return n;
}

export async function create(
  input: Omit<Watcher, "id" | "createdAt" | "enabled"> & { enabled?: boolean },
): Promise<Watcher> {
  assertLoaded();
  let id = freshId();
  while (cache[id]) id = freshId();
  const w: Watcher = {
    ...input,
    enabled: input.enabled ?? true,
    id,
    createdAt: Date.now(),
  };
  cache[id] = w;
  await persist();
  return w;
}

export async function update(
  id: string,
  patch: Partial<Omit<Watcher, "id">>,
): Promise<Watcher | undefined> {
  assertLoaded();
  const existing = cache[id];
  if (!existing) return undefined;
  const next: Watcher = { ...existing, ...patch };
  for (const k of Object.keys(patch) as (keyof typeof patch)[]) {
    if (patch[k] === undefined) delete next[k];
  }
  cache[id] = next;
  await persist();
  return next;
}

export async function remove(id: string): Promise<boolean> {
  assertLoaded();
  if (!cache[id]) return false;
  delete cache[id];
  await persist();
  return true;
}

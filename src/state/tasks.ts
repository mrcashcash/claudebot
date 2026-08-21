import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { Transport } from "./crons.ts";

/**
 * Background task rows for `/bg`. Modeled on [crons.ts](crons.ts) — same atomic
 * `tmp + rename` persist, same 8-char ids — but deliberately without the
 * fs.watch: unlike crons, these are runtime state nobody hand-edits, and a
 * reload racing a status write would lose progress.
 */

export type TaskStatus =
  | "queued"
  | "running"
  | "paused"
  | "done"
  | "failed"
  | "killed"
  | "interrupted";

/** A tool call a task is blocked on, awaiting the user's tap. */
export interface TaskPause {
  tool: string;
  toolUseId: string;
  inputSummary: string;
  since: number;
}

export interface TaskWorktree {
  path: string;
  branch: string;
  baseBranch: string;
  baseCommit: string;
}

export interface Task {
  id: string;
  chatId: string;
  /** Needed to rebuild a TurnIO after the originating handler has returned. */
  chatKind: "dm" | "group";
  userId: number | string;
  transport: Transport;
  prompt: string;
  status: TaskStatus;
  /** Checkpoint for resume — persisted the moment system/init arrives. */
  sessionId?: string;
  /** Absent when the workspace isn't a git repo (runs in place). */
  worktree?: TaskWorktree;
  /** The repo the task was launched from. */
  workspaceDir: string;
  budgetUsd: number;
  costUsd: number;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  /** Last progress line, shown by /tasks. */
  progress?: string;
  /** Chat message being live-edited with progress. */
  progressMessageId?: string;
  result?: string;
  error?: string;
  pausedOn?: TaskPause;
  /**
   * Tools this task may use without asking, granted by tapping Allow on an
   * escalation. Task-scoped so approving `git push` for one task doesn't
   * silently widen the chat's standing rules.
   */
  taskAllowTools?: string[];
}

type Store = Record<string, Task>;

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "tasks.json");
const TMP = FILE + ".tmp";
/** Rows older than this are pruned on load once they're in a terminal state. */
const KEEP_TERMINAL_MS = 7 * 24 * 60 * 60 * 1000;

const TERMINAL: ReadonlySet<TaskStatus> = new Set([
  "done",
  "failed",
  "killed",
]);

let cache: Store = {};
let loaded = false;

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL.has(status);
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

function parseStore(raw: unknown): Store {
  if (!raw || typeof raw !== "object") return {};
  const out: Store = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const o = value as Record<string, unknown>;
    if (typeof o.prompt !== "string" || typeof o.status !== "string") continue;
    if (o.chatId === undefined || o.userId === undefined) continue;
    out[id] = {
      ...(o as unknown as Task),
      id,
      chatId: String(o.chatId),
      chatKind: o.chatKind === "group" ? "group" : "dm",
      transport: o.transport === "slack" ? "slack" : "telegram",
      status: o.status as TaskStatus,
      costUsd: typeof o.costUsd === "number" ? o.costUsd : 0,
      budgetUsd: typeof o.budgetUsd === "number" ? o.budgetUsd : 5,
      createdAt: typeof o.createdAt === "number" ? o.createdAt : Date.now(),
      workspaceDir: typeof o.workspaceDir === "string" ? o.workspaceDir : "",
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
  const cutoff = Date.now() - KEEP_TERMINAL_MS;
  for (const [id, t] of Object.entries(cache)) {
    if (isTerminal(t.status) && (t.endedAt ?? t.createdAt) < cutoff) {
      delete cache[id];
    }
  }
  loaded = true;
  await persist();
}

function assertLoaded(): void {
  if (!loaded) throw new Error("tasks.load() must be called before use");
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

export function get(id: string): Task | undefined {
  assertLoaded();
  return cache[id];
}

/** Resolve a full id or unambiguous prefix. */
export function resolve(idOrPrefix: string): Task | "ambiguous" | undefined {
  assertLoaded();
  const exact = cache[idOrPrefix];
  if (exact) return exact;
  const lower = idOrPrefix.toLowerCase();
  const matches = Object.values(cache).filter((t) =>
    t.id.toLowerCase().startsWith(lower),
  );
  if (matches.length === 0) return undefined;
  if (matches.length > 1) return "ambiguous";
  return matches[0];
}

export function list(chatId?: string): Task[] {
  assertLoaded();
  const all = Object.values(cache);
  const filtered =
    chatId === undefined ? all : all.filter((t) => t.chatId === chatId);
  return filtered.sort((a, b) => b.createdAt - a.createdAt);
}

export function active(): Task[] {
  assertLoaded();
  return Object.values(cache).filter((t) => !isTerminal(t.status));
}

export function countActiveForUser(userId: number | string): number {
  assertLoaded();
  const key = String(userId);
  let n = 0;
  for (const t of Object.values(cache)) {
    if (String(t.userId) === key && (t.status === "running" || t.status === "queued")) {
      n += 1;
    }
  }
  return n;
}

export async function create(
  input: Omit<Task, "id" | "createdAt" | "costUsd" | "status">,
): Promise<Task> {
  assertLoaded();
  let id = freshId();
  while (cache[id]) id = freshId();
  const task: Task = {
    ...input,
    id,
    status: "queued",
    costUsd: 0,
    createdAt: Date.now(),
  };
  cache[id] = task;
  await persist();
  return task;
}

export async function update(
  id: string,
  patch: Partial<Omit<Task, "id">>,
): Promise<Task | undefined> {
  assertLoaded();
  const existing = cache[id];
  if (!existing) return undefined;
  const next: Task = { ...existing, ...patch };
  // An explicit `undefined` in the patch clears the field (e.g. pausedOn),
  // rather than being merged as a present-but-undefined key.
  for (const k of Object.keys(patch) as (keyof typeof patch)[]) {
    if (patch[k] === undefined) delete next[k];
  }
  cache[id] = next;
  await persist();
  return next;
}

/** Add spend to a task without clobbering a concurrent status write. */
export async function addCost(id: string, usd: number): Promise<void> {
  assertLoaded();
  const existing = cache[id];
  if (!existing) return;
  cache[id] = { ...existing, costUsd: (existing.costUsd ?? 0) + Math.max(0, usd) };
  await persist();
}

export async function allowTool(id: string, tool: string): Promise<void> {
  assertLoaded();
  const existing = cache[id];
  if (!existing) return;
  const current = existing.taskAllowTools ?? [];
  if (current.includes(tool)) return;
  cache[id] = { ...existing, taskAllowTools: [...current, tool] };
  await persist();
}

export async function remove(id: string): Promise<boolean> {
  assertLoaded();
  if (!cache[id]) return false;
  delete cache[id];
  await persist();
  return true;
}

/**
 * Boot reconciliation: a process restart kills in-flight tasks, so anything
 * left `running`/`queued` is marked `interrupted`. Their sessionIds survive, so
 * the chat can be offered a Resume button. Returns the affected rows.
 */
export async function markInterruptedOnBoot(): Promise<Task[]> {
  assertLoaded();
  const hit: Task[] = [];
  for (const [id, t] of Object.entries(cache)) {
    if (t.status === "running" || t.status === "queued") {
      cache[id] = { ...t, status: "interrupted", endedAt: Date.now() };
      hit.push(cache[id]!);
    }
  }
  if (hit.length > 0) await persist();
  return hit;
}

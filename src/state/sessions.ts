import fs from "node:fs/promises";
import path from "node:path";
import type { PermissionMode } from "../config.ts";

export interface ChatState {
  sessionId?: string;
  totalCostUsd?: number;
  model?: string;
  permissionMode?: PermissionMode;
  workspaceDir?: string;
  allowAlwaysTools?: string[];
  denyAlwaysTools?: string[];
}

type Store = Record<string, ChatState>;

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "sessions.json");
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
  loaded = true;
}

function assertLoaded(): void {
  if (!loaded) throw new Error("sessions.load() must be called before use");
}

async function persist(): Promise<void> {
  await ensureDir();
  await fs.writeFile(TMP, JSON.stringify(cache, null, 2), "utf8");
  await fs.rename(TMP, FILE);
}

export function get(chatId: number | string): ChatState {
  assertLoaded();
  return cache[String(chatId)] ?? {};
}

export async function update(
  chatId: number | string,
  patch: Partial<ChatState>,
): Promise<void> {
  assertLoaded();
  const key = String(chatId);
  cache[key] = { ...(cache[key] ?? {}), ...patch };
  await persist();
}

export async function clear(chatId: number | string): Promise<void> {
  assertLoaded();
  delete cache[String(chatId)];
  await persist();
}

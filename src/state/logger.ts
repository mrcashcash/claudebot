import fs from "node:fs/promises";
import path from "node:path";

const LOG_DIR = path.join(process.cwd(), "data", "logs");
const MAX_FIELD = 4000;
const DEFAULT_RETENTION_DAYS = 30;

export type LogCategory = "error" | "turn" | "approval" | "cron" | "lifecycle";

export interface LogRecord {
  category: LogCategory;
  event: string;
  level?: "info" | "warn" | "error";
  chatId?: string;
  userId?: number | string;
  sessionId?: string;
  [key: string]: unknown;
}

let dirReady: Promise<void> | null = null;
function ensureDir(): Promise<void> {
  if (!dirReady) {
    dirReady = fs.mkdir(LOG_DIR, { recursive: true }).then(() => {});
  }
  return dirReady;
}

export function trim(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > MAX_FIELD
      ? value.slice(0, MAX_FIELD) + `…(+${value.length - MAX_FIELD})`
      : value;
  }
  if (value && typeof value === "object") {
    try {
      const json = JSON.stringify(value);
      if (json.length <= MAX_FIELD) return value;
      return json.slice(0, MAX_FIELD) + `…(+${json.length - MAX_FIELD})`;
    } catch {
      return "[unserializable]";
    }
  }
  return value;
}

function todayLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function trimRecord(rec: LogRecord): LogRecord {
  const out: LogRecord = { category: rec.category, event: rec.event };
  for (const [k, v] of Object.entries(rec)) {
    if (k === "category" || k === "event") continue;
    out[k] = trim(v);
  }
  return out;
}

export async function log(rec: LogRecord): Promise<void> {
  try {
    await ensureDir();
    const trimmed = trimRecord(rec);
    const line =
      JSON.stringify({ ts: Date.now(), level: "info", ...trimmed }) + "\n";
    await fs.appendFile(
      path.join(LOG_DIR, `${todayLocal()}.jsonl`),
      line,
      "utf8",
    );
  } catch (err) {
    console.warn("[logger] write failed:", err);
  }
}

export async function logError(
  event: string,
  err: unknown,
  extra?: Record<string, unknown>,
): Promise<void> {
  const e =
    err instanceof Error
      ? { name: err.name, message: err.message, stack: err.stack }
      : { message: String(err) };
  await log({
    category: "error",
    event,
    level: "error",
    ...(extra ?? {}),
    err: e,
  });
}

export async function sweepOldLogs(
  retentionDays: number = DEFAULT_RETENTION_DAYS,
): Promise<void> {
  try {
    await ensureDir();
    const entries = await fs.readdir(LOG_DIR);
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    await Promise.all(
      entries.map(async (name) => {
        const m = name.match(/^(\d{4})-(\d{2})-(\d{2})\.jsonl$/);
        if (!m) return;
        const [, y, mo, d] = m;
        const fileDate = new Date(`${y}-${mo}-${d}T00:00:00`).getTime();
        if (Number.isNaN(fileDate) || fileDate >= cutoff) return;
        await fs.unlink(path.join(LOG_DIR, name)).catch(() => {});
      }),
    );
  } catch (err) {
    console.warn("[logger] sweep failed:", err);
  }
}

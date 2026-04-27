import fs from "node:fs/promises";
import path from "node:path";

const FILE = path.join(process.cwd(), "data", "turns.jsonl");

let dirReady: Promise<void> | null = null;
function ensureDir(): Promise<void> {
  if (!dirReady) {
    dirReady = fs.mkdir(path.dirname(FILE), { recursive: true }).then(() => {});
  }
  return dirReady;
}

const MAX_FIELD = 4000;

function trim(value: unknown): unknown {
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

export interface TurnRecord {
  ts: number;
  kind: "pre" | "post" | "post_failure";
  chatId: number;
  sessionId: string | undefined;
  toolUseID: string | undefined;
  tool: string;
  input?: unknown;
  response?: unknown;
  durationMs?: number;
}

export async function append(record: TurnRecord): Promise<void> {
  await ensureDir();
  const line =
    JSON.stringify({
      ...record,
      input: record.input !== undefined ? trim(record.input) : undefined,
      response:
        record.response !== undefined ? trim(record.response) : undefined,
    }) + "\n";
  await fs.appendFile(FILE, line, "utf8");
}

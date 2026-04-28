import fs from "node:fs/promises";
import path from "node:path";
import { trim } from "./logger.ts";

const FILE = path.join(process.cwd(), "data", "turns.jsonl");

let dirReady: Promise<void> | null = null;
function ensureDir(): Promise<void> {
  if (!dirReady) {
    dirReady = fs.mkdir(path.dirname(FILE), { recursive: true }).then(() => {});
  }
  return dirReady;
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

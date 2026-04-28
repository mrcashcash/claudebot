import fs from "node:fs/promises";
import path from "node:path";
import { logError } from "../state/logger.ts";

// Sentinel file consumed by scripts/dev.mjs. Its presence tells the dev
// runner "do not restart yet" — there is at least one in-flight Claude turn
// that should be allowed to finish before the bot is reloaded.
const FILE = path.join(process.cwd(), "data", ".busy");

let count = 0;
let writing = Promise.resolve();

async function writeBusy(): Promise<void> {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, String(count), "utf8");
}

async function removeBusy(): Promise<void> {
  await fs.unlink(FILE).catch((err) => {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  });
}

function chain(work: () => Promise<void>): Promise<void> {
  writing = writing.then(work, work);
  return writing;
}

export function acquire(): Promise<void> {
  count += 1;
  return chain(writeBusy).catch((err) => {
    void logError("error.busy_sentinel", err, { op: "acquire" });
    console.warn("[busy] failed to write sentinel:", err);
  });
}

export function release(): Promise<void> {
  count = Math.max(0, count - 1);
  return chain(count === 0 ? removeBusy : writeBusy).catch((err) => {
    void logError("error.busy_sentinel", err, { op: "release" });
    console.warn("[busy] failed to update sentinel:", err);
  });
}

export function reset(): Promise<void> {
  count = 0;
  return chain(removeBusy).catch((err) => {
    void logError("error.busy_sentinel", err, { op: "reset" });
    console.warn("[busy] failed to remove sentinel:", err);
  });
}

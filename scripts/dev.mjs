#!/usr/bin/env node
// Custom dev runner that respects the bot's "busy" state.
//
// `tsx watch` SIGKILLs the child 5s after SIGTERM regardless of state, which
// truncates Claude turns mid-edit. This script:
//   1. Spawns the bot with plain `tsx` (no auto-watch).
//   2. Watches src/ for .ts changes.
//   3. Debounces a burst of changes for DEBOUNCE_MS.
//   4. Before restarting, waits for the bot to drain (the sentinel file
//      data/.busy is gone) — there is no force-kill timeout.
//   5. Then SIGTERMs the child, awaits exit, and spawns a fresh bot.
//
// The bot writes data/.busy whenever inFlightChats > 0 and removes it when
// it drops to 0 (see src/busy.ts). That makes Claude turns immune to reloads
// triggered by Claude's own edits.

import { spawn } from "node:child_process";
import { watch, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = path.join(ROOT, "src");
const BUSY_FILE = path.join(ROOT, "data", ".busy");
const ENTRY = path.join(ROOT, "src", "index.ts");
const DEBOUNCE_MS = 1000;
const POLL_MS = 1000;

let child = null;
let restartTimer = null;
let restartInProgress = false;

function spawnBot() {
  console.log("[dev] starting bot...");
  child = spawn(
    process.execPath,
    ["--import", "tsx", ENTRY],
    { stdio: "inherit", cwd: ROOT },
  );
  child.on("exit", (code, signal) => {
    console.log(`[dev] bot exited code=${code} signal=${signal}`);
    child = null;
  });
}

async function waitForIdle() {
  let logged = false;
  while (existsSync(BUSY_FILE)) {
    if (!logged) {
      console.log("[dev] bot is busy (data/.busy exists), deferring restart...");
      logged = true;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  if (logged) console.log("[dev] bot idle, proceeding with restart");
}

async function restart() {
  if (restartInProgress) return;
  restartInProgress = true;
  try {
    if (!child) {
      spawnBot();
      return;
    }
    await waitForIdle();
    if (!child) {
      spawnBot();
      return;
    }
    console.log("[dev] sending SIGTERM, waiting for clean exit...");
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGTERM");
    await exited;
    spawnBot();
  } finally {
    restartInProgress = false;
  }
}

function scheduleRestart(why) {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    console.log(`[dev] reloading: ${why}`);
    restart().catch((err) => console.error("[dev] restart failed:", err));
  }, DEBOUNCE_MS);
}

watch(SRC_DIR, { recursive: true }, (_event, filename) => {
  if (!filename) return;
  if (!filename.endsWith(".ts")) return;
  scheduleRestart(filename);
});

const shutdown = (sig) => {
  console.log(`[dev] ${sig} received`);
  if (child) child.kill("SIGTERM");
  // Give the bot a chance to drain; if it's still busy, the user can hit
  // Ctrl+C again to kill the dev runner itself.
  process.once(sig, () => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

spawnBot();

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { logError } from "../state/logger.ts";

const execFileAsync = promisify(execFile);

// <repo>/src/scheduler/systemTasks.ts → repo root is two up.
const BOT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const SDK_PKG = "@anthropic-ai/claude-agent-sdk";
const SDK_REPO = "anthropics/claude-agent-sdk-typescript";
const NPM_TIMEOUT_MS = 5 * 60_000;
const GH_TIMEOUT_MS = 8_000;
/** Telegram caps messages at 4096 chars; Slack at 40k. Stay safe for both. */
const NOTES_MAX_CHARS = 2500;

export interface SystemTaskResult {
  message: string;
}

export type SystemTask = () => Promise<SystemTaskResult>;

const tasks = new Map<string, SystemTask>();

export function registerSystemTask(name: string, fn: SystemTask): void {
  tasks.set(name, fn);
}

export function getSystemTask(name: string): SystemTask | undefined {
  return tasks.get(name);
}

async function readSdkVersion(): Promise<string | null> {
  try {
    const raw = await fs.readFile(
      path.join(BOT_ROOT, "node_modules", SDK_PKG, "package.json"),
      "utf8",
    );
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

async function fetchReleaseNotes(version: string): Promise<string | null> {
  const url = `https://api.github.com/repos/${SDK_REPO}/releases/tags/v${version}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "claudebot-sdk-update",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { body?: unknown };
    return typeof data.body === "string" ? data.body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Strip the boilerplate "## Update" install snippet that every release body
 * includes, and clamp to a chat-friendly length. Plain text — no markdown
 * normalization since both transports render GitHub-flavored markdown loosely.
 */
function trimNotes(body: string): string {
  const updateIdx = body.search(/\n##\s+Update\s*\n/i);
  let out = updateIdx >= 0 ? body.slice(0, updateIdx) : body;
  out = out.trim();
  if (out.length > NOTES_MAX_CHARS) {
    out = out.slice(0, NOTES_MAX_CHARS).trimEnd() + "\n…(truncated)";
  }
  return out;
}

async function touchEntrypoint(): Promise<void> {
  const target = path.join(BOT_ROOT, "src", "index.ts");
  const now = new Date();
  try {
    await fs.utimes(target, now, now);
  } catch (err) {
    // tsx watch may not be running (e.g. `npm start`) — log but don't fail.
    void logError("error.sdk_update_touch", err, { target });
  }
}

async function runSdkUpdate(): Promise<SystemTaskResult> {
  const before = await readSdkVersion();

  try {
    await execFileAsync(
      "npm",
      ["install", "--prefix", BOT_ROOT, `${SDK_PKG}@latest`, "--silent"],
      { timeout: NPM_TIMEOUT_MS, shell: process.platform === "win32" },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void logError("error.sdk_update_install", err, {});
    return {
      message: `❌ SDK update failed:\n\`\`\`\n${msg.slice(0, 1500)}\n\`\`\``,
    };
  }

  const after = await readSdkVersion();
  if (!after) {
    return { message: "⚠️ SDK update ran but version could not be read." };
  }
  if (before === after) {
    return { message: `ℹ️ SDK already at v${after} — no update.` };
  }

  await touchEntrypoint();

  const notes = await fetchReleaseNotes(after);
  const header = before
    ? `✅ SDK updated v${before} → v${after} (reloading)`
    : `✅ SDK installed v${after} (reloading)`;
  const body = notes ? `\n\n*What's new:*\n${trimNotes(notes)}` : "";
  return { message: `${header}${body}` };
}

registerSystemTask("sdk-update", runSdkUpdate);

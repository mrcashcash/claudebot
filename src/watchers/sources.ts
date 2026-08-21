import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import type { Watcher, WatcherKind } from "../state/watchers.ts";

/**
 * Watcher sources. Each one answers a single question: "what does this thing
 * look like right now?" — as a short fingerprint. The ticker fires when the
 * fingerprint changes, which is the same idempotency trick `lastFiredAt` plays
 * for crons: restart-safe, no event queue to lose.
 *
 * A source never fires anything itself and never mutates state; it reads and
 * returns. That keeps the "did it change" decision in one place.
 */

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const HTTP_TIMEOUT_MS = 20_000;
const HTTP_MAX_BYTES = 2 * 1024 * 1024;
const LOG_MAX_TAIL_BYTES = 1 * 1024 * 1024;
const FS_MAX_ENTRIES = 4000;
const FS_SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".worktrees",
  "dist",
  ".next",
  "__pycache__",
]);

export interface Probe {
  /** Fingerprint of current state. A change from `lastKey` fires the watcher. */
  key: string;
  /** Human-readable description of what changed, injected into the prompt. */
  detail: string;
  /** Updated tail offset, for sources that stream (log). */
  cursor?: number;
}

export class SourceError extends Error {}

function hash(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new SourceError(
      `git ${args.join(" ")}: ${(e.stderr ?? e.message ?? "failed").split("\n")[0]}`,
    );
  }
}

/** New commit on a branch of the watched repo. */
async function probeGit(w: Watcher): Promise<Probe> {
  const branch = w.target.trim() || (await git(w.workspaceDir, ["rev-parse", "--abbrev-ref", "HEAD"]));
  const sha = await git(w.workspaceDir, ["rev-parse", branch]);
  const subject = await git(w.workspaceDir, [
    "log",
    "-1",
    "--pretty=%h %s (%an, %ar)",
    sha,
  ]);
  return { key: sha, detail: `new commit on ${branch}: ${subject}` };
}

/** A file or directory changed (mtime/size fingerprint). */
async function probeFs(w: Watcher): Promise<Probe> {
  const target = path.isAbsolute(w.target)
    ? w.target
    : path.resolve(w.workspaceDir, w.target);
  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    // A missing path is a state, not an error: creating it should fire.
    return { key: "missing", detail: `${w.target} does not exist` };
  }
  if (stat.isFile()) {
    return {
      key: `${stat.mtimeMs}:${stat.size}`,
      detail: `${w.target} changed (${stat.size} bytes)`,
    };
  }
  const parts: string[] = [];
  let count = 0;
  let newest = 0;
  let newestPath = "";
  const walk = async (dir: string): Promise<void> => {
    if (count >= FS_MAX_ENTRIES) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (count >= FS_MAX_ENTRIES) return;
      if (e.isDirectory()) {
        if (FS_SKIP_DIRS.has(e.name)) continue;
        await walk(path.join(dir, e.name));
        continue;
      }
      const full = path.join(dir, e.name);
      const st = await fs.stat(full).catch(() => null);
      if (!st) continue;
      count += 1;
      parts.push(`${full}:${st.mtimeMs}:${st.size}`);
      if (st.mtimeMs > newest) {
        newest = st.mtimeMs;
        newestPath = path.relative(target, full) || e.name;
      }
    }
  };
  await walk(target);
  const truncated = count >= FS_MAX_ENTRIES ? " (scan capped)" : "";
  return {
    key: hash(parts.sort().join("\n")),
    detail:
      count === 0
        ? `${w.target} is empty`
        : `${count} file(s) under ${w.target}${truncated}; newest change: ${newestPath}`,
  };
}

/** A URL's body changed. */
async function probeHttp(w: Watcher): Promise<Probe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(w.target, {
      signal: controller.signal,
      headers: { "user-agent": "claudebot-watcher/1.0" },
    });
    const text = (await res.text()).slice(0, HTTP_MAX_BYTES);
    // Status is part of the fingerprint: 200 → 500 is exactly the kind of
    // change worth waking up for.
    return {
      key: `${res.status}:${hash(text)}`,
      detail: `${w.target} → HTTP ${res.status}, ${text.length} bytes. Body starts: ${text.replace(/\s+/g, " ").slice(0, 200)}`,
    };
  } catch (err) {
    throw new SourceError(
      `fetch ${w.target}: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A regex appeared in newly-appended log content. Only the tail since the last
 * check is scanned, so a 2 GB log costs nothing per tick and old matches don't
 * re-fire. A shrunken file (rotation) resets the cursor.
 */
async function probeLog(w: Watcher): Promise<Probe> {
  const sep = w.target.indexOf("::");
  if (sep < 0) {
    throw new SourceError('log target must be "<path>::<regex>"');
  }
  const rawPath = w.target.slice(0, sep);
  const pattern = w.target.slice(sep + 2);
  const file = path.isAbsolute(rawPath)
    ? rawPath
    : path.resolve(w.workspaceDir, rawPath);
  let re: RegExp;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    throw new SourceError(`invalid regex: ${pattern}`);
  }
  const stat = await fs.stat(file).catch(() => null);
  if (!stat) throw new SourceError(`no such log file: ${file}`);

  const cursor = w.cursor ?? stat.size;
  // Rotation / truncation: start over from the new end.
  const from = stat.size < cursor ? 0 : cursor;
  if (stat.size === from) {
    return { key: w.lastKey ?? "start", detail: "no new log output", cursor: stat.size };
  }
  const length = Math.min(stat.size - from, LOG_MAX_TAIL_BYTES);
  const start = stat.size - length;
  const fh = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, start);
    const chunk = buf.toString("utf8");
    const hits = chunk.split(/\r?\n/).filter((l) => re.test(l));
    if (hits.length === 0) {
      return {
        key: w.lastKey ?? "start",
        detail: "no matching log lines",
        cursor: stat.size,
      };
    }
    const last = hits[hits.length - 1]!;
    return {
      key: hash(`${stat.size}:${last}`),
      detail: `${hits.length} new line(s) matching /${pattern}/ in ${rawPath}. Latest: ${last.slice(0, 300)}`,
      cursor: stat.size,
    };
  } finally {
    await fh.close().catch(() => {});
  }
}

const SOURCES: Record<WatcherKind, (w: Watcher) => Promise<Probe>> = {
  git: probeGit,
  fs: probeFs,
  http: probeHttp,
  log: probeLog,
};

export async function probe(w: Watcher): Promise<Probe> {
  return await SOURCES[w.kind](w);
}

/** Validate a target at creation time so a typo fails fast, in chat. */
export async function validateTarget(
  kind: WatcherKind,
  target: string,
  workspaceDir: string,
): Promise<string | null> {
  switch (kind) {
    case "git": {
      try {
        await git(workspaceDir, ["rev-parse", "--is-inside-work-tree"]);
      } catch {
        return `${workspaceDir} is not a git repo.`;
      }
      if (target.trim()) {
        try {
          await git(workspaceDir, ["rev-parse", "--verify", target.trim()]);
        } catch {
          return `No such branch or ref: ${target}`;
        }
      }
      return null;
    }
    case "fs":
      return target.trim() ? null : "fs watchers need a path.";
    case "http":
      try {
        const u = new URL(target);
        return u.protocol === "http:" || u.protocol === "https:"
          ? null
          : "http watchers need an http(s) URL.";
      } catch {
        return `Not a URL: ${target}`;
      }
    case "log": {
      if (!target.includes("::")) return 'log target must be "<path>::<regex>"';
      const pattern = target.slice(target.indexOf("::") + 2);
      try {
        new RegExp(pattern);
      } catch {
        return `Invalid regex: ${pattern}`;
      }
      return null;
    }
  }
}

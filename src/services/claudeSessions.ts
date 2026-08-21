import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

/**
 * Discovery for on-disk Claude Code sessions stored at
 * `~/.claude/projects/<slug>/<sessionId>.jsonl`. Both the host CLI and the
 * SDK (and therefore this bot) read/write the same files, so resuming a CLI
 * session from the bot only needs the session id — no handoff bundle.
 */

export interface SessionInfo {
  id: string;
  mtimeMs: number;
  sizeBytes: number;
  /** First user-typed message text from the JSONL, sliced. Empty if none. */
  preview: string;
  /** `cwd` recorded on the first user message, if any. Used for sanity. */
  cwd?: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isFullSessionId(s: string): boolean {
  return UUID_RE.test(s);
}

/**
 * Pull the plain text out of a transcript row's `message.content`, which is
 * either a bare string or an array of content blocks. Tool-use / tool-result
 * blocks are skipped — only `text` blocks are joined.
 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      parts.push((part as { text: string }).text);
    }
  }
  return parts.join("\n");
}

/**
 * Replicate Claude Code's project-dir slug rule: any path separator or drive
 * colon becomes `-`. So `D:\claudebot` → `D--claudebot`,
 * `/home/x/proj` → `-home-x-proj`.
 */
export function slugForWorkspace(absPath: string): string {
  return absPath.replace(/[\\/:]/g, "-");
}

export function projectsDirFor(workspaceDir: string): string {
  return path.join(os.homedir(), ".claude", "projects", slugForWorkspace(workspaceDir));
}

/**
 * Transcript rows that look like user messages but aren't something the user
 * typed: the CLI's local-command caveat, slash-command envelopes, command
 * stdout, and injected reminders. Skipping them is what makes a preview read
 * like the session's actual subject.
 */
function isSyntheticUserText(text: string): boolean {
  const head = text.trimStart().slice(0, 40);
  return (
    head.startsWith("<local-command-") ||
    head.startsWith("<command-name>") ||
    head.startsWith("<command-message>") ||
    head.startsWith("<command-args>") ||
    head.startsWith("<system-reminder>") ||
    head.startsWith("<user-prompt-submit-hook>") ||
    head.startsWith("Caveat: The messages below")
  );
}

async function readPreview(file: string): Promise<{ preview: string; cwd?: string }> {
  let fh: fs.FileHandle | undefined;
  try {
    fh = await fs.open(file, "r");
    // Wide enough to get past the CLI's synthetic preamble rows (caveat,
    // /clear envelope, attachments) to the first real prompt.
    const buf = Buffer.alloc(262_144);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const chunk = buf.subarray(0, bytesRead).toString("utf8");
    for (const line of chunk.split("\n")) {
      if (!line || line[0] !== "{") continue;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      if (r.type !== "user") continue;
      if (r.isMeta === true || r.isSidechain === true) continue;
      const msg = r.message as { content?: unknown } | undefined;
      const text = extractText(msg?.content);
      if (!text) continue;
      if (isSyntheticUserText(text)) continue;
      const cwd = typeof r.cwd === "string" ? r.cwd : undefined;
      return { preview: text.replace(/\s+/g, " ").trim(), cwd };
    }
    return { preview: "" };
  } catch {
    return { preview: "" };
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * List sessions for a workspace, newest-first. Returns `[]` if the projects
 * dir doesn't exist (e.g. no CLI sessions ever ran for this workspace, or
 * the bot is on a different machine than the CLI).
 */
export async function listSessions(
  workspaceDir: string,
  limit = 10,
): Promise<SessionInfo[]> {
  const dir = projectsDirFor(workspaceDir);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const stats: { id: string; mtimeMs: number; sizeBytes: number }[] = [];
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const id = name.slice(0, -".jsonl".length);
    if (!UUID_RE.test(id)) continue;
    try {
      const st = await fs.stat(path.join(dir, name));
      if (!st.isFile()) continue;
      stats.push({ id, mtimeMs: st.mtimeMs, sizeBytes: st.size });
    } catch {
      // skip
    }
  }
  stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const top = stats.slice(0, limit);
  const out: SessionInfo[] = [];
  for (const s of top) {
    const { preview, cwd } = await readPreview(path.join(dir, `${s.id}.jsonl`));
    out.push({ id: s.id, mtimeMs: s.mtimeMs, sizeBytes: s.sizeBytes, preview, cwd });
  }
  return out;
}

/** Stat + preview one session id. Returns `null` if it isn't on this disk. */
export async function describeSession(
  workspaceDir: string,
  id: string,
): Promise<SessionInfo | null> {
  if (!UUID_RE.test(id)) return null;
  const file = path.join(projectsDirFor(workspaceDir), `${id.toLowerCase()}.jsonl`);
  try {
    const st = await fs.stat(file);
    if (!st.isFile()) return null;
    const { preview, cwd } = await readPreview(file);
    return {
      id: id.toLowerCase(),
      mtimeMs: st.mtimeMs,
      sizeBytes: st.size,
      preview,
      ...(cwd ? { cwd } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Resolve a full id or a hex prefix to a session that actually exists on this
 * machine, returning its metadata. Unlike `findSessionByPrefix` this never
 * accepts an id it can't see on disk — callers that switch the live session on
 * a bare pasted id need to be able to tell "typo" from "real session".
 */
export async function findExistingSession(
  workspaceDir: string,
  token: string,
): Promise<SessionInfo | "ambiguous" | null> {
  const lower = token.toLowerCase();
  if (UUID_RE.test(lower)) return await describeSession(workspaceDir, lower);
  if (lower.length < 6) return null;
  const list = await listSessions(workspaceDir, 200);
  const matches = list.filter((s) => s.id.startsWith(lower));
  if (matches.length === 0) return null;
  if (matches.length > 1) return "ambiguous";
  return matches[0]!;
}

export interface SessionHit {
  id: string;
  mtimeMs: number;
  /** First user prompt of the session, for orientation. */
  preview: string;
  matches: { role: "user" | "assistant"; snippet: string }[];
}

const SEARCH_MAX_BYTES_PER_FILE = 12 * 1024 * 1024;

function snippetAround(text: string, needle: string, radius = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(needle);
  if (at < 0) return flat.slice(0, radius * 2);
  const start = Math.max(0, at - radius);
  const end = Math.min(flat.length, at + needle.length + radius);
  return (
    (start > 0 ? "…" : "") + flat.slice(start, end) + (end < flat.length ? "…" : "")
  );
}

/**
 * Case-insensitive substring search across the newest transcripts of a
 * workspace. Streams each `.jsonl` line-by-line (transcripts reach tens of MB)
 * and stops early per file once `perSession` snippets are collected. Only
 * `text` blocks are searched — tool inputs/outputs are ignored, which keeps
 * hits readable and avoids matching on file dumps.
 */
export async function searchSessions(
  workspaceDir: string,
  query: string,
  opts: { sessions?: number; perSession?: number } = {},
): Promise<SessionHit[]> {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return [];
  const perSession = opts.perSession ?? 3;
  const list = await listSessions(workspaceDir, opts.sessions ?? 15);
  const dir = projectsDirFor(workspaceDir);
  const out: SessionHit[] = [];
  for (const s of list) {
    const matches: SessionHit["matches"] = [];
    let bytes = 0;
    const stream = createReadStream(path.join(dir, `${s.id}.jsonl`), {
      encoding: "utf8",
    });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        bytes += line.length + 1;
        if (bytes > SEARCH_MAX_BYTES_PER_FILE) break;
        if (!line || line[0] !== "{") continue;
        // Cheap pre-filter before the JSON.parse cost.
        if (!line.toLowerCase().includes(needle)) continue;
        let row: unknown;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        const r = row as Record<string, unknown>;
        if (r.type !== "user" && r.type !== "assistant") continue;
        if (r.isMeta === true) continue;
        const msg = r.message as { content?: unknown } | undefined;
        const text = extractText(msg?.content);
        if (!text || !text.toLowerCase().includes(needle)) continue;
        if (isSyntheticUserText(text)) continue;
        matches.push({
          role: r.type === "user" ? "user" : "assistant",
          snippet: snippetAround(text, needle),
        });
        if (matches.length >= perSession) break;
      }
    } catch {
      // unreadable transcript — skip it
    } finally {
      rl.close();
      stream.destroy();
    }
    if (matches.length > 0) {
      out.push({ id: s.id, mtimeMs: s.mtimeMs, preview: s.preview, matches });
    }
  }
  return out;
}

/**
 * Find a session by full id or unambiguous prefix. Returns `null` if no
 * match, or `"ambiguous"` if the prefix matches multiple sessions.
 */
export async function findSessionByPrefix(
  workspaceDir: string,
  prefix: string,
): Promise<string | "ambiguous" | null> {
  const lower = prefix.toLowerCase();
  if (UUID_RE.test(lower)) {
    const dir = projectsDirFor(workspaceDir);
    try {
      await fs.stat(path.join(dir, `${lower}.jsonl`));
      return lower;
    } catch {
      return lower; // accept full UUID even if not on this disk
    }
  }
  if (lower.length < 4) return null;
  const list = await listSessions(workspaceDir, 200);
  const matches = list.filter((s) => s.id.startsWith(lower));
  if (matches.length === 0) return null;
  if (matches.length > 1) return "ambiguous";
  return matches[0]!.id;
}

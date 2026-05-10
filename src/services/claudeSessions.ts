import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

async function readPreview(file: string): Promise<{ preview: string; cwd?: string }> {
  let fh: fs.FileHandle | undefined;
  try {
    fh = await fs.open(file, "r");
    const buf = Buffer.alloc(32_768);
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
      const msg = r.message as { content?: unknown } | undefined;
      const content = msg?.content;
      let text = "";
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (
            part &&
            typeof part === "object" &&
            (part as { type?: unknown }).type === "text" &&
            typeof (part as { text?: unknown }).text === "string"
          ) {
            text = (part as { text: string }).text;
            break;
          }
        }
      }
      if (!text) continue;
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

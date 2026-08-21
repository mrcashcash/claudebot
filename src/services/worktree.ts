import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { TaskWorktree } from "../state/tasks.ts";

/**
 * Git worktree plumbing for background tasks. Each task gets its own checkout
 * under `<repo>/.worktrees/task-<id>` on branch `task/<id>`, which buys two
 * things: concurrent tasks can't fight over the same files, and a task's output
 * is a reviewable branch rather than an edit you have to trust blind.
 *
 * A third, less obvious benefit for this repo specifically: `scripts/dev.mjs`
 * watches only `<repo>/src`, so a task editing the bot's own source inside a
 * worktree doesn't trigger a reload mid-run.
 */

// execFile, never exec: every argument below is passed as an array element, so
// no shell parses branch names or paths. Task ids are base64url so they can't
// contain shell metacharacters either, but the array form is the real guard.
const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;

export const WORKTREE_DIR = ".worktrees";

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new GitError(
      `git ${args[0]} failed: ${(e.stderr ?? e.message ?? "").split("\n")[0]}`,
      e.stderr ?? "",
    );
  }
}

/**
 * Paths from `git status --porcelain`, minus the XY status prefix and any
 * quoting. Used to ignore the `.worktrees/` directory itself: it lives inside
 * the repo, so an un-ignored one makes the parent tree look permanently dirty
 * and would block every merge.
 */
function porcelainPaths(out: string): string[] {
  return out
    .split(/\r?\n/)
    .filter((l) => l.length > 3)
    .map((l) => l.slice(3).trim().replace(/^"|"$/g, ""))
    // Renames read as "old -> new"; the destination is what matters.
    .map((p) => (p.includes(" -> ") ? p.slice(p.indexOf(" -> ") + 4) : p));
}

async function isDirty(dir: string): Promise<boolean> {
  const out = await git(dir, ["status", "--porcelain"]);
  return porcelainPaths(out).some(
    (p) => p !== WORKTREE_DIR && !p.startsWith(`${WORKTREE_DIR}/`),
  );
}

/**
 * Teach the repo to ignore `.worktrees/` via `.git/info/exclude` rather than
 * the tracked `.gitignore` — task isolation is this bot's business, not a
 * change to the user's committed files.
 */
async function ensureWorktreeIgnored(repoDir: string): Promise<void> {
  const excludeFile = path.join(repoDir, ".git", "info", "exclude");
  const entry = `${WORKTREE_DIR}/`;
  try {
    const current = await fs.readFile(excludeFile, "utf8").catch(() => "");
    if (current.split(/\r?\n/).some((l) => l.trim() === entry)) return;
    await fs.mkdir(path.dirname(excludeFile), { recursive: true });
    const prefix = current === "" || current.endsWith("\n") ? "" : "\n";
    await fs.appendFile(excludeFile, `${prefix}${entry}\n`, "utf8");
  } catch {
    // Best effort — `isDirty` filters the path anyway.
  }
}

/** True when `dir` is inside a git work tree (and not itself a worktree dir). */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const out = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
    return out === "true";
  } catch {
    return false;
  }
}

/** Refuse to nest: a worktree inside a worktree confuses cleanup badly. */
export async function isInsideWorktree(dir: string): Promise<boolean> {
  return path.resolve(dir).split(path.sep).includes(WORKTREE_DIR);
}

export async function currentBranch(repoDir: string): Promise<string> {
  const out = await git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return out === "HEAD" ? "" : out;
}

/**
 * Create the task's worktree. The branch forks from the repo's current HEAD, so
 * a task started from a feature branch continues that line of work rather than
 * jumping to main.
 */
export async function create(
  repoDir: string,
  taskId: string,
): Promise<TaskWorktree> {
  const baseBranch = await currentBranch(repoDir);
  const baseCommit = await git(repoDir, ["rev-parse", "HEAD"]);
  const wtPath = path.join(repoDir, WORKTREE_DIR, `task-${taskId}`);
  const branch = `task/${taskId}`;
  await fs.mkdir(path.join(repoDir, WORKTREE_DIR), { recursive: true });
  await ensureWorktreeIgnored(repoDir);
  await git(repoDir, ["worktree", "add", "-b", branch, wtPath, baseCommit]);
  return { path: wtPath, branch, baseBranch: baseBranch || baseCommit, baseCommit };
}

export interface DiffSummary {
  filesChanged: number;
  insertions: number;
  deletions: number;
  /** `git diff --stat` body, truncated by the caller for display. */
  stat: string;
  commits: number;
  /** True when the worktree has changes that were never committed. */
  dirty: boolean;
}

export async function summarize(wt: TaskWorktree): Promise<DiffSummary> {
  const stat = await git(wt.path, ["diff", "--stat", wt.baseCommit, "--"]);
  const dirty = await isDirty(wt.path);
  const commitList = await git(wt.path, [
    "rev-list",
    "--count",
    `${wt.baseCommit}..HEAD`,
  ]);
  // The summary line looks like " 3 files changed, 12 insertions(+), 4 deletions(-)".
  const last = stat.split("\n").filter(Boolean).pop() ?? "";
  const num = (re: RegExp): number => {
    const m = re.exec(last);
    return m ? Number(m[1]) : 0;
  };
  return {
    filesChanged: num(/(\d+) files? changed/),
    insertions: num(/(\d+) insertions?\(\+\)/),
    deletions: num(/(\d+) deletions?\(-\)/),
    stat,
    commits: Number(commitList) || 0,
    dirty,
  };
}

/** Full patch text, for sending as a file. */
export async function diffText(wt: TaskWorktree): Promise<string> {
  return await git(wt.path, ["diff", wt.baseCommit, "--"]);
}

/**
 * Commit whatever the task left uncommitted, so the branch is a complete
 * record even when Claude never ran `git commit` itself.
 */
export async function commitAll(
  wt: TaskWorktree,
  message: string,
): Promise<boolean> {
  if (!(await isDirty(wt.path))) return false;
  await git(wt.path, ["add", "-A"]);
  await git(wt.path, ["commit", "-m", message, "--no-verify"]);
  return true;
}

export interface MergeResult {
  ok: boolean;
  /** Conflict paths, when the merge stopped. */
  conflicts?: string[];
  message: string;
}

/**
 * Merge the task branch back into its base. On conflict the merge is aborted
 * and reported — open question 2 in the design doc is settled this way
 * deliberately: an auto-rebase of an autonomous change is exactly where a
 * silent wrong resolution would hurt most.
 */
export async function merge(
  repoDir: string,
  wt: TaskWorktree,
): Promise<MergeResult> {
  const current = await currentBranch(repoDir);
  if (current !== wt.baseBranch) {
    return {
      ok: false,
      message:
        `The repo is on \`${current || "a detached HEAD"}\` but this task branched from ` +
        `\`${wt.baseBranch}\`. Switch back and merge again, or merge \`${wt.branch}\` by hand.`,
    };
  }
  if (await isDirty(repoDir)) {
    return {
      ok: false,
      message:
        "The main working tree has uncommitted changes. Commit or stash them, then merge again.",
    };
  }
  try {
    await git(repoDir, ["merge", "--no-ff", "-m", `merge ${wt.branch}`, wt.branch]);
    return { ok: true, message: `Merged \`${wt.branch}\` into \`${wt.baseBranch}\`.` };
  } catch (err) {
    const conflicts = await git(repoDir, ["diff", "--name-only", "--diff-filter=U"])
      .then((s) => s.split("\n").filter(Boolean))
      .catch(() => []);
    await git(repoDir, ["merge", "--abort"]).catch(() => {});
    return {
      ok: false,
      ...(conflicts.length > 0 ? { conflicts } : {}),
      message:
        `Merge conflicted and was aborted${conflicts.length > 0 ? ` on: ${conflicts.slice(0, 8).join(", ")}` : ""}. ` +
        `Nothing changed. The work is still on \`${wt.branch}\` — resolve it there, or start a follow-up task: ` +
        `${err instanceof GitError ? err.message : String(err)}`,
    };
  }
}

/** Remove the worktree and its branch. Best-effort; never throws. */
export async function discard(
  repoDir: string,
  wt: TaskWorktree,
): Promise<void> {
  await git(repoDir, ["worktree", "remove", "--force", wt.path]).catch(() => {});
  await git(repoDir, ["branch", "-D", wt.branch]).catch(() => {});
  await fs.rm(wt.path, { recursive: true, force: true }).catch(() => {});
  await git(repoDir, ["worktree", "prune"]).catch(() => {});
}

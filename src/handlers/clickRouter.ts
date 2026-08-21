/**
 * Transport-agnostic dispatch for inline-button clicks.
 *
 * Both Telegram and Slack callback handlers funnel through this router to
 * (a) settle the matching approval / question and (b) update the prompt
 * message with the resolution. The transport-specific bits (Telegram's
 * `answerCbQuery` toast, Slack's `ack()`) stay in each transport's
 * `actions.ts`; everything else lives here.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as questions from "./questions.ts";
import { applyPermissionCallback, type PermissionVerdict } from "./toolApprovals.ts";
import type { TurnIO } from "./turnIO.ts";
import * as taskRunner from "../core/taskRunner.ts";
import * as tasks from "../state/tasks.ts";
import * as worktree from "../services/worktree.ts";
import { log } from "../state/logger.ts";

const MESSAGE_HARD_CAP = 4000;

function truncate(s: string, max: number = MESSAGE_HARD_CAP): string {
  return s.length <= max ? s : s.slice(0, max) + `\n…(+${s.length - max} chars)`;
}

export interface ClickContext {
  io: TurnIO;
  /** Id of the message the buttons were attached to. */
  messageId: string;
  /** Current text of that message — used to append a resolution suffix. */
  originalText: string;
  /** User who clicked, for audit log. */
  userId?: number | string;
}

export interface ApprovalClickResult {
  matched: boolean;
  verdict?: PermissionVerdict;
}

export interface QuestionClickResult {
  matched: boolean;
  toast?: string;
}

/**
 * Route a `perm:*` click. Returns `{ matched: false }` when `data` isn't a
 * permission callback, so callers can try other prefixes.
 */
export async function dispatchApprovalClick(
  data: string,
  ctx: ClickContext,
): Promise<ApprovalClickResult> {
  const verdict = applyPermissionCallback(data);
  if (!verdict) return { matched: false };

  void log({
    category: "approval",
    event: "approval.decision",
    chatId: ctx.io.chatId,
    userId: ctx.userId,
    toolUseId: verdict.toolUseId,
    decision:
      verdict.scope === "always"
        ? `always_${verdict.decision}`
        : verdict.decision,
    settled: verdict.settled,
    transport: ctx.io.transport,
  });

  try {
    await ctx.io.editMessage(
      ctx.messageId,
      truncate(ctx.originalText + verdict.resolutionSuffix),
      { parseMode: "markdown" },
    );
  } catch {
    // Edit failed (message gone, formatting rejected). Fall back to dropping
    // just the buttons so the user at least sees the prompt is closed.
    try {
      await ctx.io.removeButtons(ctx.messageId);
    } catch {
      // ignore
    }
  }

  if (!verdict.settled) {
    try {
      await ctx.io.reply(
        "(That request already expired or was already answered.)",
      );
    } catch {
      // ignore
    }
  }

  return { matched: true, verdict };
}

export interface TaskClickResult {
  matched: boolean;
  toast?: string;
}

/**
 * Route a `task:<action>:<id>` click — the buttons on a background task's
 * pause prompt and completion report. Actions:
 *
 * - `allow`   — approve the paused tool and resume the task
 * - `kill`    — abort a running task, or give up on a paused one
 * - `diff`    — post the branch's patch as a file
 * - `merge`   — merge the branch into the base it forked from
 * - `discard` — remove the worktree and delete the branch
 */
export async function dispatchTaskClick(
  data: string,
  ctx: ClickContext,
): Promise<TaskClickResult> {
  const m = data.match(/^task:(allow|kill|diff|merge|discard):(.+)$/);
  if (!m) return { matched: false };
  const action = m[1] as "allow" | "kill" | "diff" | "merge" | "discard";
  const taskId = m[2]!;

  void log({
    category: "approval",
    event: "task.click",
    chatId: ctx.io.chatId,
    userId: ctx.userId,
    taskId,
    action,
    transport: ctx.io.transport,
  });

  const task = tasks.get(taskId);
  if (!task) {
    try {
      await ctx.io.removeButtons(ctx.messageId);
    } catch {
      // ignore
    }
    return { matched: true, toast: "That task is gone" };
  }

  switch (action) {
    case "allow": {
      // Doubles as plain "resume": a task interrupted by a restart has no
      // pending tool, it just needs to be put back on the queue.
      const tool = task.pausedOn?.tool;
      if (tool) {
        await taskRunner.approvePausedTool(taskId);
        await settleButtons(ctx, `\n\n✅ *Allowed ${tool}* — task resuming.`);
        return { matched: true, toast: `Allowed ${tool}` };
      }
      if (tasks.isTerminal(task.status)) {
        return { matched: true, toast: "That task already finished" };
      }
      await taskRunner.resumeTask(taskId);
      await settleButtons(ctx, "\n\n▶️ *Resuming.*");
      return { matched: true, toast: "Resuming" };
    }
    case "kill": {
      const stopped = taskRunner.killTask(taskId);
      if (!stopped) {
        // Not in flight: a paused task the user has given up on.
        await tasks.update(taskId, {
          status: "killed",
          endedAt: Date.now(),
          pausedOn: undefined,
        });
      }
      await settleButtons(ctx, "\n\n🛑 *Stopped.*");
      return { matched: true, toast: "Task stopped" };
    }
    case "diff": {
      if (!task.worktree) return { matched: true, toast: "No branch to diff" };
      try {
        const patch = await worktree.diffText(task.worktree);
        if (patch.trim().length === 0) {
          await ctx.io.reply(`Task \`${taskId}\` changed nothing.`, {
            parseMode: "markdown",
          });
          return { matched: true, toast: "No changes" };
        }
        const file = path.join(os.tmpdir(), `task-${taskId}.patch`);
        await fs.writeFile(file, patch, "utf8");
        await ctx.io.sendDocument(file, {
          caption: `task ${taskId} · ${task.worktree.branch}`,
        });
        await fs.rm(file, { force: true }).catch(() => {});
        return { matched: true, toast: "Diff sent" };
      } catch (err) {
        await ctx.io.reply(
          `Couldn't produce the diff: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { matched: true, toast: "Diff failed" };
      }
    }
    case "merge": {
      if (!task.worktree) return { matched: true, toast: "No branch to merge" };
      const result = await worktree.merge(task.workspaceDir, task.worktree);
      await ctx.io.reply(
        result.ok ? `🔀 ${result.message}` : `⚠️ ${result.message}`,
        { parseMode: "markdown" },
      );
      if (result.ok) {
        await worktree.discard(task.workspaceDir, task.worktree);
        await tasks.update(taskId, { worktree: undefined });
        await settleButtons(ctx, "\n\n🔀 *Merged* — worktree cleaned up.");
      }
      return { matched: true, toast: result.ok ? "Merged" : "Merge blocked" };
    }
    case "discard": {
      if (task.worktree) {
        await worktree.discard(task.workspaceDir, task.worktree);
        await tasks.update(taskId, { worktree: undefined });
      }
      if (!tasks.isTerminal(task.status)) {
        taskRunner.killTask(taskId);
        await tasks.update(taskId, {
          status: "killed",
          endedAt: Date.now(),
          pausedOn: undefined,
        });
      }
      await settleButtons(ctx, "\n\n🗑 *Discarded* — branch and worktree removed.");
      return { matched: true, toast: "Discarded" };
    }
  }
}

/** Append a resolution line and drop the buttons, tolerating edit failures. */
async function settleButtons(ctx: ClickContext, suffix: string): Promise<void> {
  try {
    await ctx.io.editMessage(ctx.messageId, truncate(ctx.originalText + suffix), {
      parseMode: "markdown",
    });
  } catch {
    try {
      await ctx.io.removeButtons(ctx.messageId);
    } catch {
      // ignore
    }
  }
}

/**
 * Route a `q:*` click. Returns `{ matched: false }` when `data` isn't a
 * question callback. On a stale click, removes the buttons so the user
 * can't keep poking; on a successful click, the question handler itself
 * has already advanced the prompt.
 */
export async function dispatchQuestionClick(
  data: string,
  ctx: ClickContext,
): Promise<QuestionClickResult> {
  if (!data.startsWith("q:")) return { matched: false };
  const outcome = await questions.handleClick(data);
  if (!outcome) return { matched: true };
  if (!outcome.ok) {
    try {
      await ctx.io.removeButtons(ctx.messageId);
    } catch {
      // ignore
    }
  }
  return { matched: true, toast: outcome.toast };
}

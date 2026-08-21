import os from "node:os";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config.ts";
import { askClaude, AskClaudeAbortedError } from "../services/claude.ts";
import { buildSendFileMcp } from "../services/sendFileMcp.ts";
import { buildSessionsMcp } from "../services/sessionsMcp.ts";
import * as worktree from "../services/worktree.ts";
import { buildCanUseTool } from "../handlers/toolApprovals.ts";
import type { ButtonGrid, TurnIO } from "../handlers/turnIO.ts";
import * as sessions from "../state/sessions.ts";
import * as tasks from "../state/tasks.ts";
import type { Task } from "../state/tasks.ts";
import * as users from "../state/users.ts";
import { log, logError } from "../state/logger.ts";
import * as budget from "./budget.ts";
import { ioFor } from "./ioRegistry.ts";

/**
 * Background tasks. A task is a Claude turn that runs *off* the chat's serial
 * queue (see `turnEngine.turnTailsMap`), in its own git worktree, under its own
 * budget, reporting progress into the chat it was started from.
 *
 * Deliberately a separate runner rather than a branch inside `runTurn`: almost
 * every step differs (no streaming reply, no voice, no lastPrompt, different
 * cwd, escalation instead of blocking approval), and forking the main
 * conversational path to accommodate all that would have been the riskier
 * change. The shared pieces — askClaude, buildCanUseTool, budget, the MCP
 * servers — are imported, not copied.
 *
 * Three properties worth preserving if you edit this:
 *
 * 1. Tasks never acquire the `.busy` sentinel. Holding it would block every
 *    dev reload for the length of the task; instead a task is checkpointed by
 *    its sessionId and resumed after a restart.
 * 2. A task that hits an ungated tool *pauses* (frees its slot, keeps its
 *    worktree) rather than hanging on a button or dying like a cron fire.
 * 3. Its worktree is never removed implicitly — the user discards it.
 */

export const TASK_CONCURRENCY_DEFAULT = 2;
export const TASK_BUDGET_DEFAULT_USD = 5;
/** A paused task gives up after this long without an approval. */
const PAUSE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const PROGRESS_EDIT_MS = 10_000;
const PROGRESS_MAX_CHARS = 400;
const RESULT_MAX_CHARS = 2500;

let config: Config | undefined;
const running = new Map<string, AbortController>();
const queue: string[] = [];
let sweeper: NodeJS.Timeout | undefined;
let shuttingDown = false;

export function init(cfg: Config): void {
  config = cfg;
}

function globalCap(): number {
  return Math.max(1, Math.min(4, os.cpus().length - 2));
}

function ioForTask(task: Task): TurnIO | undefined {
  return ioFor(task.transport, task.chatId, task.chatKind);
}

function shortId(id: string): string {
  return id.slice(0, 6);
}

function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}

function statusIcon(status: Task["status"]): string {
  switch (status) {
    case "queued":
      return "⏳";
    case "running":
      return "⚙️";
    case "paused":
      return "⏸";
    case "done":
      return "✅";
    case "failed":
      return "❌";
    case "killed":
      return "🛑";
    case "interrupted":
      return "🔌";
  }
}

function durationString(task: Task): string {
  const start = task.startedAt ?? task.createdAt;
  const end = task.endedAt ?? Date.now();
  const sec = Math.max(0, Math.round((end - start) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h${min % 60}m`;
}

/** Buttons offered on a finished task that produced a branch. */
function resultButtons(task: Task): ButtonGrid | undefined {
  if (!task.worktree) return undefined;
  return [
    [
      { label: "📄 Diff", callbackId: `task:diff:${task.id}` },
      { label: "🔀 Merge", callbackId: `task:merge:${task.id}` },
      { label: "🗑 Discard", callbackId: `task:discard:${task.id}` },
    ],
  ];
}

async function say(
  task: Task,
  text: string,
  buttons?: ButtonGrid,
): Promise<string | undefined> {
  const io = ioForTask(task);
  if (!io) return undefined;
  try {
    const sent = await io.reply(text, {
      parseMode: "markdown",
      ...(buttons ? { buttons } : {}),
    });
    return sent.messageId;
  } catch {
    try {
      const sent = await io.reply(text.replace(/[*_`]/g, ""), {
        ...(buttons ? { buttons } : {}),
      });
      return sent.messageId;
    } catch {
      return undefined;
    }
  }
}

/**
 * Create a task and enqueue it. Returns the row plus a human-facing note about
 * how it was set up (worktree vs in-place), which the caller echoes to the chat.
 */
export async function startTask(args: {
  chatId: string;
  chatKind: "dm" | "group";
  userId: number | string;
  transport: Task["transport"];
  prompt: string;
  budgetUsd?: number;
}): Promise<{ task: Task; note: string }> {
  if (!config) throw new Error("taskRunner.init(config) must be called first");
  const workspaceDir = users.effectiveWorkspace(
    args.chatId,
    args.userId,
    config.gatewayDir,
  );
  const budgetUsd = args.budgetUsd ?? TASK_BUDGET_DEFAULT_USD;

  // The worktree is named after the task id, so the row has to exist first.
  const isRepo = await worktree.isGitRepo(workspaceDir);
  const nested = await worktree.isInsideWorktree(workspaceDir);
  const task = await tasks.create({
    chatId: args.chatId,
    chatKind: args.chatKind,
    userId: args.userId,
    transport: args.transport,
    prompt: args.prompt,
    workspaceDir,
    budgetUsd,
  });

  let note: string;
  if (nested) {
    note =
      "⚠️ This workspace is itself a task worktree — no nested isolation, running in place.";
  } else if (!isRepo) {
    // Open question 1, settled: run anyway rather than refusing, but warn and
    // serialize per workspace since there's nothing keeping tasks apart.
    note =
      "⚠️ Not a git repo, so there's no isolation and no diff to review — running in place, " +
      "one task at a time for this workspace, and with permission prompts left on " +
      "(a mistake here hits your real files).";
  } else {
    try {
      const created = await worktree.create(workspaceDir, task.id);
      await tasks.update(task.id, { worktree: created });
      note =
        `Isolated in \`${worktree.WORKTREE_DIR}/task-${task.id}\` on branch \`${created.branch}\` ` +
        `(from \`${created.baseBranch}\`).`;
    } catch (err) {
      note =
        `⚠️ Worktree setup failed (${err instanceof Error ? err.message : String(err)}) — ` +
        "running in the workspace directly, so changes land in your working tree.";
    }
  }

  const fresh = tasks.get(task.id) ?? task;
  queue.push(task.id);
  void log({
    category: "turn",
    event: "task.created",
    chatId: task.chatId,
    userId: task.userId,
    taskId: task.id,
    worktree: fresh.worktree?.path,
    budgetUsd,
  });
  pump();
  return { task: fresh, note };
}

/**
 * Re-enqueue a paused/interrupted task, continuing its Claude session.
 *
 * Note the deliberate lack of a `running.has(id)` early-return: approving a
 * paused tool typically happens while the *previous* run is still winding down
 * (the pause message is sent from inside canUseTool, before the model finishes
 * its wrap-up). Bailing out then would drop the resume on the floor, so the id
 * goes on the queue regardless and `pump()` holds it until the slot clears.
 */
export async function resumeTask(id: string): Promise<Task | undefined> {
  const task = tasks.get(id);
  if (!task) return undefined;
  const next = await tasks.update(id, { status: "queued", endedAt: undefined });
  if (!queue.includes(id)) queue.push(id);
  pump();
  return next;
}

export function killTask(id: string): boolean {
  const ctrl = running.get(id);
  const queuedAt = queue.indexOf(id);
  if (queuedAt >= 0) queue.splice(queuedAt, 1);
  if (ctrl) {
    ctrl.abort("task_killed");
    return true;
  }
  return queuedAt >= 0;
}

export function isRunning(id: string): boolean {
  return running.has(id);
}

export function queueDepth(): number {
  return queue.length;
}

/**
 * Start whatever the caps allow. Called after every state change; cheap enough
 * to be unconditional.
 */
function pump(): void {
  if (shuttingDown) return;
  for (let i = 0; i < queue.length; ) {
    const id = queue[i]!;
    const task = tasks.get(id);
    if (!task || tasks.isTerminal(task.status)) {
      queue.splice(i, 1);
      continue;
    }
    // A resume can be queued while the previous run is still finishing; wait
    // for it rather than starting the same task twice.
    if (running.has(id)) {
      i += 1;
      continue;
    }
    if (!canStart(task)) {
      i += 1;
      continue;
    }
    queue.splice(i, 1);
    void run(id).catch((err) => {
      void logError("error.task_run", err, { taskId: id });
      console.error(`[task] ${id} crashed:`, err);
    });
  }
}

function canStart(task: Task): boolean {
  if (running.size >= globalCap()) return false;
  const userCap =
    users.get(task.userId)?.maxConcurrentTasks ?? TASK_CONCURRENCY_DEFAULT;
  let sameUser = 0;
  let sameWorkspaceInPlace = 0;
  for (const id of running.keys()) {
    const t = tasks.get(id);
    if (!t) continue;
    if (String(t.userId) === String(task.userId)) sameUser += 1;
    if (!t.worktree && t.workspaceDir === task.workspaceDir) {
      sameWorkspaceInPlace += 1;
    }
  }
  if (sameUser >= userCap) return false;
  // No worktree means no isolation, so in-place tasks in one workspace are
  // serialized — two of them would fight over the same files.
  if (!task.worktree && sameWorkspaceInPlace >= 1) return false;
  return true;
}

function taskGuidance(task: Task, cwd: string): string {
  return `You are running as a BACKGROUND TASK (id \`${task.id}\`) started from a chat, not in a live conversation.

- Your working directory is \`${cwd}\`${task.worktree ? `, a dedicated git worktree on branch \`${task.worktree.branch}\`. Commit your work there; the user reviews and merges the branch from chat.` : ". There is NO isolation — this is the user's live working tree, and permission prompts are on, so prefer additive changes and avoid destructive commands."}
- Nobody is reading along in real time. Do not ask questions; make the most reasonable assumption, state it explicitly in your final summary, and continue.
- If a tool call needs permission you don't have, the task pauses and the user is asked. Prefer approaches that use what you already have.
- Your final message IS the report the user reads. Lead with what changed and what you verified (tests, typecheck, commands run). Be concrete about files. If you couldn't finish, say exactly where you stopped and what the next step is.
- Budget for this task: $${task.budgetUsd.toFixed(2)}. Work efficiently; don't explore beyond the ask.`;
}

async function run(id: string): Promise<void> {
  if (!config) throw new Error("taskRunner.init(config) must be called first");
  const start = tasks.get(id);
  if (!start) return;

  const io = ioForTask(start);
  if (!io) {
    await tasks.update(id, {
      status: "failed",
      error: `No ${start.transport} transport registered — cannot report progress.`,
      endedAt: Date.now(),
    });
    return;
  }

  // Budget gate, same as an interactive turn: a task must not be the thing
  // that blows through the monthly cap.
  const verdict = budget.check(start.chatId, start.userId);
  if (!verdict.ok) {
    await tasks.update(id, {
      status: "failed",
      error: "monthly budget reached",
      endedAt: Date.now(),
    });
    await say(start, `🎫 \`${shortId(id)}\` not started — ${verdict.message}`);
    return;
  }

  const controller = new AbortController();
  running.set(id, controller);
  const resuming = start.sessionId !== undefined;
  const task =
    (await tasks.update(id, {
      status: "running",
      startedAt: start.startedAt ?? Date.now(),
      pausedOn: undefined,
      endedAt: undefined,
    })) ?? start;
  const cwd = task.worktree?.path ?? task.workspaceDir;

  void log({
    category: "turn",
    event: "task.start",
    chatId: task.chatId,
    userId: task.userId,
    taskId: id,
    resumed: resuming,
    cwd,
  });
  console.log(
    `[task] start ${id} chat=${task.chatId} cwd=${cwd} resumed=${resuming}`,
  );

  // Progress message: reused across resumes so a task owns one live line.
  let progressMessageId = task.progressMessageId;
  if (!progressMessageId) {
    progressMessageId = await say(
      task,
      `⚙️ \`${shortId(id)}\` running…\n_${clip(task.prompt, 120)}_`,
    );
    if (progressMessageId) {
      await tasks.update(id, { progressMessageId });
    }
  }
  let lastEdit = 0;
  const pushProgress = (full: string): void => {
    const now = Date.now();
    if (now - lastEdit < PROGRESS_EDIT_MS) return;
    lastEdit = now;
    const line = clip(full.slice(-PROGRESS_MAX_CHARS * 2), PROGRESS_MAX_CHARS);
    void tasks.update(id, { progress: line });
    if (!progressMessageId) return;
    void io
      .editMessage(
        progressMessageId,
        `⚙️ \`${shortId(id)}\` running (${durationString(task)})…\n\n${line}`,
        { parseMode: "markdown" },
      )
      .catch(() => {});
  };

  let paused = false;
  const onEscalate = async (
    tool: string,
    input: Record<string, unknown>,
    toolUseId: string,
  ): Promise<PermissionResult> => {
    const current = tasks.get(id);
    if ((current?.taskAllowTools ?? []).includes(tool)) {
      return { behavior: "allow", updatedInput: input };
    }
    paused = true;
    const summary = (() => {
      try {
        return JSON.stringify(input).slice(0, 400);
      } catch {
        return "[unserializable]";
      }
    })();
    await tasks.update(id, {
      status: "paused",
      pausedOn: { tool, toolUseId, inputSummary: summary, since: Date.now() },
    });
    await say(
      tasks.get(id) ?? task,
      `⏸ *Task \`${shortId(id)}\` needs permission*\n\n` +
        `Tool: *${tool}*\n\`\`\`\n${clip(summary, 300)}\n\`\`\`\n` +
        `_Approving resumes the task where it stopped. It gives up after 24h._`,
      [
        [
          { label: `✅ Allow & resume`, callbackId: `task:allow:${id}` },
          { label: "🛑 Give up", callbackId: `task:kill:${id}` },
        ],
      ],
    );
    return {
      behavior: "deny",
      message:
        `Paused: ${tool} needs the user's approval, which has been requested. ` +
        "Stop now and summarize what you were about to do and why — the task will be resumed with permission granted.",
    };
  };

  const canUseTool = buildCanUseTool(io, task.chatId, controller.signal, "task", {
    workspaceDir: cwd,
    taskId: id,
    onEscalate,
  });

  const spentSoFar = task.costUsd ?? 0;
  const taskRemaining = Math.max(0.01, task.budgetUsd - spentSoFar);
  const caps = [taskRemaining];
  if (verdict.turnCapUsd !== undefined) caps.push(verdict.turnCapUsd);

  const prompt = resuming
    ? "Continue the task from where you stopped. If you were waiting on a tool call, the user has now approved it — retry it and carry on."
    : task.prompt;

  try {
    const reply = await askClaude(prompt, {
      ...(task.sessionId ? { resumeSessionId: task.sessionId } : {}),
      cwd,
      // With a worktree, inherit the chat's mode: edits land in a throwaway
      // checkout the user reviews before merging, and pausing on every file
      // write would make tasks useless. Running *in place* there's nothing to
      // contain a mistake, so force "default" — verified to gate destructive
      // shell commands that `acceptEdits` waves through.
      permissionMode: task.worktree
        ? users.effectiveMode(task.chatId, task.userId)
        : "default",
      ...(users.effectiveModel(task.chatId, task.userId)
        ? { model: users.effectiveModel(task.chatId, task.userId)! }
        : {}),
      canUseTool,
      chatId: task.chatId,
      signal: controller.signal,
      maxBudgetUsd: Math.min(...caps),
      mcpServers: {
        claudebot: buildSendFileMcp(io, cwd),
        sessions: buildSessionsMcp({
          chatId: task.chatId,
          workspaceDir: cwd,
          signal: controller.signal,
          ...(task.sessionId ? { currentSessionId: task.sessionId } : {}),
        }),
      },
      appendSystemPrompt: taskGuidance(task, cwd),
      ...(cwd === config.gatewayDir
        ? {}
        : { additionalDirectories: [config.gatewayDir] }),
      onSessionId: async (sid) => {
        await tasks.update(id, { sessionId: sid });
      },
      onTextDelta: (_delta, full) => pushProgress(full),
    });

    await tasks.addCost(id, reply.costUsd);
    const chatState = sessions.get(task.chatId);
    await sessions.update(task.chatId, {
      totalCostUsd: (chatState.totalCostUsd ?? 0) + reply.costUsd,
    });
    const spend = await budget.recordSpend(
      task.chatId,
      task.userId,
      reply.costUsd,
    );

    if (paused) {
      // The escalation message is already in the chat; leave the row paused.
      void log({
        category: "turn",
        event: "task.paused",
        chatId: task.chatId,
        taskId: id,
        tool: tasks.get(id)?.pausedOn?.tool,
      });
      return;
    }

    await finish(id, reply.text, spend.warning);
  } catch (err) {
    if (err instanceof AskClaudeAbortedError || controller.signal.aborted) {
      const reason =
        typeof controller.signal.reason === "string"
          ? controller.signal.reason
          : "aborted";
      const killed = reason === "task_killed";
      await tasks.update(id, {
        status: killed ? "killed" : "interrupted",
        endedAt: Date.now(),
      });
      void log({
        category: "turn",
        event: killed ? "task.killed" : "task.interrupted",
        chatId: task.chatId,
        taskId: id,
      });
      if (killed) {
        const t = tasks.get(id) ?? task;
        await say(
          t,
          `🛑 Task \`${shortId(id)}\` stopped after ${durationString(t)} · $${(t.costUsd ?? 0).toFixed(2)}.` +
            (t.worktree
              ? `\nIts branch \`${t.worktree.branch}\` is intact — review or discard it below.`
              : ""),
          resultButtons(t),
        );
      }
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    void logError("error.task_run", err, { taskId: id, chatId: task.chatId });
    await tasks.update(id, {
      status: "failed",
      error: msg.slice(0, 1500),
      endedAt: Date.now(),
    });
    await say(
      tasks.get(id) ?? task,
      `❌ Task \`${shortId(id)}\` failed after ${durationString(task)}:\n\`\`\`\n${clip(msg, 600)}\n\`\`\``,
      resultButtons(tasks.get(id) ?? task),
    );
  } finally {
    running.delete(id);
    pump();
  }
}

/** Commit leftovers, summarize, report. */
async function finish(
  id: string,
  resultText: string,
  budgetWarning?: string,
): Promise<void> {
  const task = tasks.get(id);
  if (!task) return;

  let diffLine = "";
  if (task.worktree) {
    try {
      await worktree.commitAll(
        task.worktree,
        `task ${task.id}: ${clip(task.prompt, 60)}`,
      );
      const sum = await worktree.summarize(task.worktree);
      diffLine =
        sum.filesChanged > 0 || sum.commits > 0
          ? `\n*Changes:* ${sum.filesChanged} file(s) +${sum.insertions}/−${sum.deletions} in ${sum.commits} commit(s) on \`${task.worktree.branch}\``
          : `\n*Changes:* none — nothing was modified`;
    } catch (err) {
      diffLine = `\n⚠️ Couldn't summarize the branch: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const updated =
    (await tasks.update(id, {
      status: "done",
      endedAt: Date.now(),
      result: resultText.slice(0, 8000),
      progress: undefined,
    })) ?? task;

  void log({
    category: "turn",
    event: "task.done",
    chatId: task.chatId,
    taskId: id,
    durationMs: (updated.endedAt ?? Date.now()) - (updated.startedAt ?? updated.createdAt),
    costUsd: updated.costUsd,
  });

  const body = resultText.trim().length > 0 ? resultText.trim() : "(no summary returned)";
  const header =
    `✅ *Task \`${shortId(id)}\` done* · ${durationString(updated)} · $${(updated.costUsd ?? 0).toFixed(2)}` +
    diffLine;
  await say(
    updated,
    `${header}\n\n${clip(body, RESULT_MAX_CHARS)}`,
    resultButtons(updated),
  );
  if (budgetWarning) await say(updated, budgetWarning);
}

/** Called by the task-click handler when the user approves a paused tool. */
export async function approvePausedTool(id: string): Promise<Task | undefined> {
  const task = tasks.get(id);
  if (!task || !task.pausedOn) return task;
  await tasks.allowTool(id, task.pausedOn.tool);
  return await resumeTask(id);
}

/** Fail tasks that have been waiting on an approval for too long. */
async function sweep(): Promise<void> {
  const now = Date.now();
  for (const task of tasks.active()) {
    if (task.status !== "paused" || !task.pausedOn) continue;
    if (now - task.pausedOn.since < PAUSE_TIMEOUT_MS) continue;
    await tasks.update(task.id, {
      status: "failed",
      error: `no approval for ${task.pausedOn.tool} within 24h`,
      endedAt: now,
    });
    await say(
      task,
      `⌛ Task \`${shortId(task.id)}\` gave up — *${task.pausedOn.tool}* was never approved.` +
        (task.worktree ? `\nIts branch \`${task.worktree.branch}\` is still there.` : ""),
      resultButtons(task),
    );
  }
}

export function startSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    void sweep().catch((err) => {
      void logError("error.task_sweep", err);
    });
  }, SWEEP_INTERVAL_MS);
  sweeper.unref?.();
}

export function stopSweeper(): void {
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = undefined;
  }
}

/**
 * Shutdown: stop dispatching and abort what's in flight. Rows stay `running` on
 * disk on purpose — `tasks.markInterruptedOnBoot()` reconciles them on the next
 * boot and offers the user a Resume button, which is more reliable than trying
 * to persist a status write during process teardown.
 */
export function beginShutdown(reason: string): number {
  shuttingDown = true;
  queue.length = 0;
  for (const ctrl of running.values()) ctrl.abort(reason);
  return running.size;
}

export function runningIds(): string[] {
  return [...running.keys()];
}

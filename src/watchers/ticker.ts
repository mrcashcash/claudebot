import * as watchers from "../state/watchers.ts";
import type { Watcher } from "../state/watchers.ts";
import * as tasks from "../state/tasks.ts";
import * as taskRunner from "../core/taskRunner.ts";
import { probe, SourceError } from "./sources.ts";
import { getNotify } from "../scheduler/transport.ts";
import { log, logError } from "../state/logger.ts";

/**
 * The watcher loop. One `setInterval` for all watchers, mirroring
 * [scheduler/ticker.ts](../scheduler/ticker.ts): a single timer, per-row
 * interval checks, and state written before dispatch so a crash can't double
 * fire.
 *
 * Firing creates a background task rather than a bare turn, so watcher work
 * gets a worktree, a budget, progress reporting and escalation without this
 * file knowing anything about them.
 */

const TICK_MS = 30_000;
/** Errors are announced once per streak, not every tick. */
const ERROR_NOTIFY_EVERY = 20;

let timer: NodeJS.Timeout | undefined;
let ticking = false;
const errorStreak = new Map<string, number>();

function dueNow(w: Watcher, now: number): boolean {
  if (!w.enabled) return false;
  const last = w.lastCheckedAt ?? 0;
  return now - last >= w.intervalSec * 1000;
}

async function notify(w: Watcher, text: string): Promise<void> {
  const fn = getNotify(w.transport);
  if (fn) await fn(w.chatId, text).catch(() => {});
}

async function checkOne(w: Watcher, now: number): Promise<void> {
  let result;
  try {
    result = await probe(w);
  } catch (err) {
    const msg = err instanceof SourceError ? err.message : String(err);
    const streak = (errorStreak.get(w.id) ?? 0) + 1;
    errorStreak.set(w.id, streak);
    await watchers.update(w.id, { lastCheckedAt: now, lastError: msg });
    // Tell the user the first time, then only occasionally — a watcher pointed
    // at a dead URL shouldn't spam the chat every 30 seconds.
    if (streak === 1 || streak % ERROR_NOTIFY_EVERY === 0) {
      await notify(
        w,
        `⚠️ Watcher \`${w.id}\` (${w.kind}) can't read its target: ${msg.slice(0, 300)}` +
          (streak > 1 ? `\n(${streak} consecutive failures)` : ""),
      );
    }
    return;
  }
  errorStreak.delete(w.id);

  const first = w.lastKey === undefined;
  const changed = !first && result.key !== w.lastKey;

  // First observation only records the baseline. Firing on it would mean every
  // new watcher immediately reacts to whatever already existed — the same
  // reason the cron ticker ignores slots older than `createdAt`.
  await watchers.update(w.id, {
    lastCheckedAt: now,
    lastKey: result.key,
    lastError: undefined,
    ...(result.cursor !== undefined ? { cursor: result.cursor } : {}),
  });
  if (!changed) return;

  // Don't stack tasks: if the previous fire is still working, skip this one.
  // The next change will pick things up.
  if (w.lastTaskId) {
    const prev = tasks.get(w.lastTaskId);
    if (prev && !tasks.isTerminal(prev.status)) {
      void log({
        category: "cron",
        event: "watcher.skipped",
        chatId: w.chatId,
        watcherId: w.id,
        reason: "previous_task_active",
        taskId: prev.id,
      });
      await notify(
        w,
        `👀 Watcher \`${w.id}\` saw a change but task \`${prev.id}\` from the last one is still ${prev.status} — skipping this round.`,
      );
      return;
    }
  }

  const prompt =
    `${w.prompt}\n\n---\n_Triggered by watcher \`${w.id}\` (${w.kind}): ${result.detail}_`;

  void log({
    category: "cron",
    event: "watcher.fired",
    chatId: w.chatId,
    userId: w.userId,
    watcherId: w.id,
    kind: w.kind,
    detail: result.detail.slice(0, 300),
  });
  console.log(`[watch] fire ${w.id} kind=${w.kind} — ${result.detail.slice(0, 120)}`);

  try {
    const { task, note } = await taskRunner.startTask({
      chatId: w.chatId,
      chatKind: w.chatKind,
      userId: w.userId,
      transport: w.transport,
      prompt,
    });
    await watchers.update(w.id, {
      lastFiredAt: now,
      lastTaskId: task.id,
      fireCount: (w.fireCount ?? 0) + 1,
    });
    await notify(
      w,
      `👀 Watcher \`${w.id}\` fired — ${result.detail.slice(0, 200)}\n` +
        `🎫 Task \`${task.id}\` queued. ${note}`,
    );
  } catch (err) {
    void logError("error.watcher_fire", err, { watcherId: w.id });
    await notify(
      w,
      `⚠️ Watcher \`${w.id}\` fired but the task couldn't start: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    for (const w of watchers.allEnabled()) {
      if (!dueNow(w, now)) continue;
      await checkOne(w, now).catch((err) => {
        void logError("error.watcher_tick", err, { watcherId: w.id });
      });
    }
  } finally {
    ticking = false;
  }
}

export function start(): void {
  if (timer) return;
  timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  timer.unref?.();
  const count = watchers.allEnabled().length;
  console.log(
    `[watch] ticker started (${TICK_MS / 1000}s) — ${count} enabled watcher(s)`,
  );
}

export function stop(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

/** Evaluate one watcher immediately without firing — powers `/watch test`. */
export async function testOne(
  id: string,
): Promise<{ ok: true; detail: string; changed: boolean } | { ok: false; error: string }> {
  const w = watchers.get(id);
  if (!w) return { ok: false, error: "no such watcher" };
  try {
    const result = await probe(w);
    return {
      ok: true,
      detail: result.detail,
      changed: w.lastKey !== undefined && result.key !== w.lastKey,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

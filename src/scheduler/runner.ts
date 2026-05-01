import type { Cron } from "../state/crons.ts";
import { log, logError } from "../state/logger.ts";
import { getTransportKickOff, getNotify } from "./transport.ts";
import { getSystemTask } from "./systemTasks.ts";

/**
 * Fire a cron job. Two paths:
 *  - `systemTask` is set → run the named in-process task and post its result
 *    via the transport's notifyChat. No Claude turn, no permissions, no cost.
 *  - otherwise → build the prompt (with an optional "ran late" prefix when
 *    catching up after downtime) and dispatch through the transport's
 *    fire-and-forget turn pipeline.
 */
export function fire(c: Cron, lateMs: number): void {
  console.log(
    `[cron] fire id=${c.id} transport=${c.transport} chat=${c.chatId} user=${c.userId} late=${Math.round(lateMs / 1000)}s ${c.systemTask ? `systemTask=${c.systemTask}` : `resume=${c.resume}`}`,
  );
  void log({
    category: "cron",
    event: "cron.fired",
    chatId: c.chatId,
    userId: c.userId,
    cronId: c.id,
    transport: c.transport,
    lateMs,
    oneShot: c.oneShot === true,
    resume: c.resume,
    ...(c.systemTask ? { systemTask: c.systemTask } : {}),
  });

  if (c.systemTask) {
    void runSystemTask(c, lateMs);
    return;
  }

  const lateNote =
    lateMs >= 60_000
      ? `_(⏰ ran ${Math.round(lateMs / 60_000)}m late — bot was offline)_\n\n`
      : "";
  const prompt = `${lateNote}${c.prompt}`;
  const dispatch = getTransportKickOff(c.transport);
  if (!dispatch) {
    console.warn(
      `[cron] no transport registered for "${c.transport}" — dropping fire id=${c.id}`,
    );
    return;
  }
  dispatch(c.chatId, c.userId, prompt, {
    triggerSource: "cron",
    persistSession: c.resume,
  });
}

async function runSystemTask(c: Cron, lateMs: number): Promise<void> {
  const taskName = c.systemTask!;
  const task = getSystemTask(taskName);
  const notify = getNotify(c.transport);
  if (!task) {
    console.warn(
      `[cron] unknown systemTask "${taskName}" — dropping fire id=${c.id}`,
    );
    if (notify) {
      await notify(
        c.chatId,
        `⚠️ Cron \`${c.id}\` references unknown system task "${taskName}" — disable or update it.`,
      ).catch(() => {});
    }
    return;
  }
  if (!notify) {
    console.warn(
      `[cron] no notify registered for "${c.transport}" — running task "${taskName}" but no result will be posted`,
    );
  }

  const lateNote =
    lateMs >= 60_000
      ? `_(⏰ ran ${Math.round(lateMs / 60_000)}m late — bot was offline)_\n\n`
      : "";
  try {
    const result = await task();
    if (notify) await notify(c.chatId, `${lateNote}${result.message}`);
  } catch (err) {
    void logError("error.system_task", err, {
      cronId: c.id,
      systemTask: taskName,
    });
    const msg = err instanceof Error ? err.message : String(err);
    if (notify) {
      await notify(
        c.chatId,
        `❌ System task "${taskName}" failed: ${msg.slice(0, 1500)}`,
      ).catch(() => {});
    }
  }
}

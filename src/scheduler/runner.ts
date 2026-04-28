import type { Cron } from "../state/crons.ts";
import { log } from "../state/logger.ts";
import { getTransportKickOff } from "./transport.ts";

/**
 * Fire a cron job. Builds the prompt (with an optional "ran late" prefix
 * when catching up after downtime) and dispatches it through the bot's
 * fire-and-forget turn pipeline.
 */
export function fire(c: Cron, lateMs: number): void {
  const lateNote =
    lateMs >= 60_000
      ? `_(⏰ ran ${Math.round(lateMs / 60_000)}m late — bot was offline)_\n\n`
      : "";
  const prompt = `${lateNote}${c.prompt}`;
  const dispatch = getTransportKickOff(c.transport);
  console.log(
    `[cron] fire id=${c.id} transport=${c.transport} chat=${c.chatId} user=${c.userId} late=${Math.round(lateMs / 1000)}s resume=${c.resume}`,
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
  });
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

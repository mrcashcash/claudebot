import type { Cron } from "../state/crons.ts";
import { log } from "../state/logger.ts";

export interface RunnerDeps {
  /**
   * The same kickOffTurnFromCron exposed by buildBot. Fire-and-forget; the
   * runner does not wait for the turn to finish.
   */
  kickOffTurnFromCron: (
    chatId: number,
    userId: number,
    prompt: string,
    opts?: { triggerSource?: "cron"; persistSession?: boolean },
  ) => void;
}

/**
 * Fire a cron job. Builds the prompt (with an optional "ran late" prefix
 * when catching up after downtime) and dispatches it through the bot's
 * fire-and-forget turn pipeline.
 */
export function fire(deps: RunnerDeps, c: Cron, lateMs: number): void {
  const lateNote =
    lateMs >= 60_000
      ? `_(⏰ ran ${Math.round(lateMs / 60_000)}m late — bot was offline)_\n\n`
      : "";
  const prompt = `${lateNote}${c.prompt}`;
  console.log(
    `[cron] fire id=${c.id} chat=${c.chatId} user=${c.userId} late=${Math.round(lateMs / 1000)}s resume=${c.resume}`,
  );
  void log({
    category: "cron",
    event: "cron.fired",
    chatId: c.chatId,
    userId: c.userId,
    cronId: c.id,
    lateMs,
    oneShot: c.oneShot === true,
    resume: c.resume,
  });
  deps.kickOffTurnFromCron(c.chatId, c.userId, prompt, {
    triggerSource: "cron",
    persistSession: c.resume,
  });
}

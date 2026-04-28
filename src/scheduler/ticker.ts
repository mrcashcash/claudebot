import { CronExpressionParser } from "cron-parser";
import * as crons from "../state/crons.ts";
import * as users from "../state/users.ts";
import { fire } from "./runner.ts";
import { log, logError } from "../state/logger.ts";

const TICK_MS = 60_000;
/** Catch-up window: fire missed jobs only if their slot is within this many ms. */
const CATCH_UP_MS = 30 * 60_000;

let handle: NodeJS.Timeout | null = null;
let running = false;

function bucketMinute(ms: number): number {
  return ms - (ms % 60_000);
}

async function tick(): Promise<void> {
  if (running) {
    // Should never happen given our timing, but guard against re-entry.
    return;
  }
  running = true;
  try {
    const now = Date.now();
    const nowBucket = bucketMinute(now);

    for (const c of crons.allEnabled()) {
      try {
        // currentDate is set slightly in the future so prev() returns the most
        // recent past or current-minute slot — easier than checking next()
        // for "is this exactly now."
        const tz = users.tzFor(c.userId);
        const it = CronExpressionParser.parse(c.cron, {
          tz,
          currentDate: new Date(now + 1000),
        });
        const prevMs = it.prev().toDate().getTime();
        const prevBucket = bucketMinute(prevMs);

        // Already fired this slot — idempotent.
        if (c.lastFiredAt !== undefined && c.lastFiredAt >= prevBucket) continue;

        const isCurrentMinute = prevBucket === nowBucket;
        const lateMs = now - prevBucket;
        const withinCatchUp = !isCurrentMinute && lateMs <= CATCH_UP_MS;
        if (!isCurrentMinute && !withinCatchUp) {
          if (c.oneShot) {
            await crons.remove(c.id);
            console.log(
              `[cron] ${c.id} oneShot — missed catch-up window, deleted without firing`,
            );
          } else {
            await crons.update(c.id, { lastFiredAt: prevBucket });
          }
          void log({
            category: "cron",
            event: "cron.skipped_too_old",
            cronId: c.id,
            chatId: c.chatId,
            userId: c.userId,
            transport: c.transport,
            lateMs,
            oneShotDeleted: c.oneShot === true,
          });
          continue;
        }

        // Reserve before dispatching so a slow persist doesn't get retried.
        await crons.update(c.id, { lastFiredAt: prevBucket });
        fire(c, isCurrentMinute ? 0 : lateMs);
        if (c.oneShot) {
          await crons.remove(c.id);
          console.log(`[cron] ${c.id} oneShot — deleted after fire`);
        }
      } catch (e) {
        void logError("error.cron_tick", e, {
          cronId: c.id,
          chatId: c.chatId,
          userId: c.userId,
        });
        void log({
          category: "cron",
          event: "cron.tick_error",
          cronId: c.id,
          chatId: c.chatId,
          userId: c.userId,
          message: e instanceof Error ? e.message : String(e),
        });
        console.warn(
          `[cron] ${c.id} tick error: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  } finally {
    running = false;
  }
}

export function start(): void {
  if (handle) return;
  // Immediate first tick on boot for catch-up; then every minute.
  void tick();
  handle = setInterval(() => void tick(), TICK_MS);
  console.log(
    `[cron] ticker started interval=${TICK_MS}ms catchUp=${CATCH_UP_MS / 60_000}min (tz is per-user)`,
  );
}

export function stop(): void {
  if (!handle) return;
  clearInterval(handle);
  handle = null;
  console.log(`[cron] ticker stopped`);
}

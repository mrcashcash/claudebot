import { CronExpressionParser } from "cron-parser";
import * as crons from "../state/crons.ts";
import * as users from "../state/users.ts";
import { fire, type RunnerDeps } from "./runner.ts";

const TICK_MS = 60_000;
/** Catch-up window: fire missed jobs only if their slot is within this many ms. */
const CATCH_UP_MS = 30 * 60_000;

let handle: NodeJS.Timeout | null = null;
let running = false;

function bucketMinute(ms: number): number {
  return ms - (ms % 60_000);
}

async function tick(deps: RunnerDeps): Promise<void> {
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
          // The slot is more than 30 minutes ago and we missed it — record so
          // we don't keep checking it forever, but don't fire. For one-shot
          // crons, drop them entirely instead of leaving a stale row that
          // would refire on the next year/week match of the cron expression.
          if (c.oneShot) {
            await crons.remove(c.id);
            console.log(
              `[cron] ${c.id} oneShot — missed catch-up window, deleted without firing`,
            );
          } else {
            await crons.update(c.id, { lastFiredAt: prevBucket });
          }
          continue;
        }

        // Reserve before dispatching so a slow persist doesn't get retried.
        await crons.update(c.id, { lastFiredAt: prevBucket });
        fire(deps, c, isCurrentMinute ? 0 : lateMs);
        // One-shot crons auto-delete after their first dispatch so a date-
        // specific expression like "0 10 3 5 *" doesn't refire every year.
        if (c.oneShot) {
          await crons.remove(c.id);
          console.log(`[cron] ${c.id} oneShot — deleted after fire`);
        }
      } catch (e) {
        console.warn(
          `[cron] ${c.id} tick error: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  } finally {
    running = false;
  }
}

export function start(deps: RunnerDeps): void {
  if (handle) return;
  // Immediate first tick on boot for catch-up; then every minute.
  void tick(deps);
  handle = setInterval(() => void tick(deps), TICK_MS);
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

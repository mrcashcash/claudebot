import * as sessions from "../state/sessions.ts";
import * as users from "../state/users.ts";
import { log } from "../state/logger.ts";

/**
 * Spend ceilings. Two independent limits:
 *
 * - **Monthly cap** — enforced by this module against a per-chat month bucket
 *   (`ChatState.monthUsd` + `monthKey`). Checked before a turn starts and
 *   incremented after it ends. Chat-scoped so a shared group can't drain the
 *   owner's personal allowance.
 * - **Per-turn cap** — handed to the SDK as `maxBudgetUsd`, so a runaway turn
 *   stops itself mid-flight instead of being caught after the fact.
 *
 * The month bucket rolls in the *user's* timezone, so "this month" means what
 * the user thinks it means.
 */

export const WARN_PCT = 80;

export interface BudgetStatus {
  monthKey: string;
  spentUsd: number;
  /** Monthly cap, or undefined when uncapped. */
  capUsd?: number;
  /** Per-turn cap, or undefined when uncapped. */
  perTurnUsd?: number;
  /** Percent of the monthly cap spent, or undefined when uncapped. */
  pct?: number;
  /** Remaining monthly allowance, or undefined when uncapped. */
  remainingUsd?: number;
}

/** "2026-08" in the given tz. Falls back to UTC if the tz is unusable. */
export function monthKeyFor(tz: string, now = Date.now()): string {
  for (const zone of [tz, "UTC"]) {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
      }).formatToParts(new Date(now));
      const y = parts.find((p) => p.type === "year")?.value;
      const m = parts.find((p) => p.type === "month")?.value;
      if (y && m) return `${y}-${m}`;
    } catch {
      // bad tz — try UTC on the next pass
    }
  }
  return new Date(now).toISOString().slice(0, 7);
}

function capFor(
  chatId: number | string,
  userId: number | string,
): number | undefined {
  const chatCap = sessions.get(chatId).budgetUsd;
  if (typeof chatCap === "number" && chatCap > 0) return chatCap;
  const userCap = users.get(userId)?.budget?.monthlyUsd;
  return typeof userCap === "number" && userCap > 0 ? userCap : undefined;
}

function perTurnFor(userId: number | string): number | undefined {
  const v = users.get(userId)?.budget?.perTurnUsd;
  return typeof v === "number" && v > 0 ? v : undefined;
}

export function statusFor(
  chatId: number | string,
  userId: number | string,
  now = Date.now(),
): BudgetStatus {
  const state = sessions.get(chatId);
  const monthKey = monthKeyFor(users.tzFor(userId), now);
  // A stale bucket reads as zero spend; the reset is persisted lazily by
  // `recordSpend`, so a month rollover needs no scheduled job.
  const spentUsd = state.monthKey === monthKey ? (state.monthUsd ?? 0) : 0;
  const capUsd = capFor(chatId, userId);
  const perTurnUsd = perTurnFor(userId);
  return {
    monthKey,
    spentUsd,
    ...(capUsd !== undefined ? { capUsd } : {}),
    ...(perTurnUsd !== undefined ? { perTurnUsd } : {}),
    ...(capUsd !== undefined
      ? {
          pct: Math.min(999, Math.round((spentUsd / capUsd) * 100)),
          remainingUsd: Math.max(0, capUsd - spentUsd),
        }
      : {}),
  };
}

export interface BudgetVerdict {
  ok: boolean;
  status: BudgetStatus;
  /** User-facing refusal text, present only when `ok` is false. */
  message?: string;
  /**
   * `maxBudgetUsd` to hand the SDK for this turn: the per-turn cap, clamped to
   * whatever is left of the monthly cap. Undefined = no ceiling.
   */
  turnCapUsd?: number;
}

/**
 * Gate a turn. Call this *after* the queue dequeues, not at enqueue time — a
 * turn that waited behind others must be judged against current spend.
 */
export function check(
  chatId: number | string,
  userId: number | string,
  now = Date.now(),
): BudgetVerdict {
  const status = statusFor(chatId, userId, now);
  const monthName = status.monthKey;
  if (status.capUsd !== undefined && status.spentUsd >= status.capUsd) {
    return {
      ok: false,
      status,
      message:
        `🛑 *Monthly budget reached* — $${status.spentUsd.toFixed(2)} of the ` +
        `$${status.capUsd.toFixed(2)} cap for ${monthName}.\n\n` +
        "Raise it with `/budget monthly <usd>` or remove it with `/budget monthly off`.",
    };
  }
  const caps: number[] = [];
  if (status.perTurnUsd !== undefined) caps.push(status.perTurnUsd);
  if (status.remainingUsd !== undefined) caps.push(status.remainingUsd);
  const turnCapUsd = caps.length > 0 ? Math.min(...caps) : undefined;
  return {
    ok: true,
    status,
    ...(turnCapUsd !== undefined ? { turnCapUsd } : {}),
  };
}

export interface SpendResult {
  status: BudgetStatus;
  /** Set when this spend pushed the chat past WARN_PCT for the first time. */
  warning?: string;
}

/**
 * Add spend to the chat's month bucket, rolling it if the month changed.
 * Returns the new status plus a one-shot warning string when the chat crosses
 * WARN_PCT (tracked via `budgetWarnedPct` so it fires once per month).
 *
 * Callers must keep passing `totalCostUsd` in their own `sessions.update` —
 * this only owns the month bucket, so the two writes stay independent.
 */
export async function recordSpend(
  chatId: number | string,
  userId: number | string,
  usd: number,
  now = Date.now(),
): Promise<SpendResult> {
  const state = sessions.get(chatId);
  const monthKey = monthKeyFor(users.tzFor(userId), now);
  const rolled = state.monthKey !== monthKey;
  const spentUsd = (rolled ? 0 : (state.monthUsd ?? 0)) + Math.max(0, usd);
  const priorWarn = rolled ? undefined : state.budgetWarnedPct;

  const capUsd = capFor(chatId, userId);
  const pct =
    capUsd !== undefined ? Math.round((spentUsd / capUsd) * 100) : undefined;
  const crossed =
    pct !== undefined && pct >= WARN_PCT && (priorWarn ?? 0) < WARN_PCT;

  await sessions.update(chatId, {
    monthKey,
    monthUsd: spentUsd,
    budgetWarnedPct: crossed ? WARN_PCT : priorWarn,
  });

  const status = statusFor(chatId, userId, now);
  if (!crossed) return { status };

  void log({
    category: "turn",
    event: "budget.warning",
    chatId: String(chatId),
    userId,
    spentUsd,
    capUsd,
    pct,
  });
  return {
    status,
    warning:
      `⚠️ *Budget ${pct}% used* — $${spentUsd.toFixed(2)} of $${capUsd!.toFixed(2)} ` +
      `for ${monthKey}. Turns stop at the cap; \`/budget\` to adjust.`,
  };
}

/** One-line summary for /status and /cost. */
export function summaryLine(status: BudgetStatus): string {
  if (status.capUsd === undefined) {
    return `$${status.spentUsd.toFixed(2)} this month (${status.monthKey}) · no cap`;
  }
  return (
    `$${status.spentUsd.toFixed(2)} / $${status.capUsd.toFixed(2)} this month ` +
    `(${status.monthKey}, ${status.pct}%)`
  );
}

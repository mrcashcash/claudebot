/**
 * Transport-agnostic dispatch for inline-button clicks.
 *
 * Both Telegram and Slack callback handlers funnel through this router to
 * (a) settle the matching approval / question and (b) update the prompt
 * message with the resolution. The transport-specific bits (Telegram's
 * `answerCbQuery` toast, Slack's `ack()`) stay in each transport's
 * `actions.ts`; everything else lives here.
 */

import * as questions from "./questions.ts";
import { applyPermissionCallback, type PermissionVerdict } from "./toolApprovals.ts";
import type { TurnIO } from "./turnIO.ts";
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

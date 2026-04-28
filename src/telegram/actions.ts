import type { Telegraf, Context } from "telegraf";
import { callbackQuery } from "telegraf/filters";
import {
  dispatchApprovalClick,
  dispatchQuestionClick,
} from "../handlers/clickRouter.ts";
import { ioFromContext } from "./io.ts";

/**
 * Best-effort `ctx.answerCbQuery` that swallows the "query is too old" / "query
 * ID is invalid" errors Telegram returns when the bot answers a callback after
 * a restart.
 */
export async function safeAnswerCbQuery(
  ctx: Context,
  text?: string,
): Promise<void> {
  try {
    await ctx.answerCbQuery(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("query is too old") ||
      msg.includes("query ID is invalid")
    ) {
      const data =
        ctx.callbackQuery && "data" in ctx.callbackQuery
          ? ctx.callbackQuery.data
          : "";
      console.warn(
        `[cb] answerCbQuery dropped (too old) chat=${ctx.chat?.id} data="${data}"`,
      );
      return;
    }
    console.warn("[cb] answerCallbackQuery failed:", msg);
  }
}

/**
 * Wire the Telegraf `callback_query` handler to route `q:*` (AskUserQuestion)
 * and `perm:*` (tool approvals) clicks through the shared click router.
 */
export function registerTelegramActions(bot: Telegraf): void {
  bot.on(callbackQuery("data"), async (ctx) => {
    const data = ctx.callbackQuery.data;
    console.log(
      `[cb] received user=${ctx.from?.id} chat=${ctx.chat?.id} data="${data}"`,
    );

    const message = ctx.callbackQuery.message;
    if (!message || !ctx.chat) {
      await safeAnswerCbQuery(ctx);
      return;
    }
    const messageId = String(message.message_id);
    const originalText = "text" in message ? (message.text ?? "") : "";
    const io = ioFromContext(ctx);
    const clickCtx = {
      io,
      messageId,
      originalText,
      userId: ctx.from?.id,
    };

    if (data.startsWith("q:")) {
      const result = await dispatchQuestionClick(data, clickCtx);
      await safeAnswerCbQuery(ctx, result.toast);
      return;
    }

    if (data.startsWith("perm:")) {
      const result = await dispatchApprovalClick(data, clickCtx);
      await safeAnswerCbQuery(ctx, result.verdict?.toastLabel);
      return;
    }

    await safeAnswerCbQuery(ctx);
  });
}

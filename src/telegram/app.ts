import { Telegraf, type Context } from "telegraf";
import { message } from "telegraf/filters";
import type { Config } from "../config.ts";
import type { AskClaudeAttachment } from "../services/claude.ts";
import * as users from "../state/users.ts";
import { ioFromContext, ioFromTelegram } from "./io.ts";
import { COMMAND_MENU, registerCommands } from "./commands.ts";
import { registerMediaHandlers } from "./mediaHandlers.ts";
import { registerTelegramActions } from "./actions.ts";
import { shouldRespond } from "./respondGate.ts";
import { buildReplyContext } from "./replyContext.ts";
import type { TurnEngine, KickOffOptions } from "../core/turnEngine.ts";
import type { TriggerSource } from "../handlers/toolApprovals.ts";
import { logError } from "../state/logger.ts";

export { COMMAND_MENU } from "./commands.ts";

/**
 * Public-facing opts object used by Telegraf-handler callbacks (commands +
 * media handlers) to feed a turn into `kickOffTurnFromContext`. A subset of
 * `KickOffOptions` — handlers don't pick `triggerSource`/`persistSession`,
 * those are scheduler-only knobs.
 */
export interface KickOffFromCtxOptions {
  attachments?: AskClaudeAttachment[];
  /** Wall-clock anchor (ms since epoch) for upstream latency tracing. */
  traceStart?: number;
  /** True when the originating user message was a voice/audio note. */
  inputWasVoice?: boolean;
}

export interface TelegramApp {
  bot: Telegraf;
  /** Register the menu of slash commands with Telegram (best-effort). */
  setMyCommands(): Promise<void>;
  /** Begin polling. */
  start(): Promise<void>;
  /** Stop polling. */
  stop(reason: string): Promise<void>;
  /** Cron entry point — used by the scheduler transport registry. */
  kickOffTurnFromCron(
    chatId: string,
    userId: number | string,
    prompt: string,
    opts?: KickOffOptions,
  ): void;
  /** Send a one-off notice to a chat (used during graceful reload). Silently
   *  drops chats whose id isn't a numeric Telegram id. */
  notifyChat(chatId: string, text: string): Promise<void>;
  /** Bot's @username, available after `start()`. */
  username(): string | undefined;
}

export function buildTelegramApp(
  config: Config,
  engine: TurnEngine,
  bootTime: number,
): TelegramApp {
  const bot = new Telegraf(config.telegramBotToken);
  bot.catch((err, ctx) => {
    void logError("error.bot_global", err, {
      updateId: ctx.update.update_id,
      updateType: ctx.updateType,
      chatId: ctx.chat?.id,
      userId: ctx.from?.id,
    });
    console.error(
      `[bot] handler error for update ${ctx.update.update_id}:`,
      err,
    );
  });

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId === undefined || !config.allowedUserIds.has(userId)) {
      console.warn(
        `[auth] rejected update_id=${ctx.update.update_id} type=${ctx.updateType} user_id=${userId ?? "unknown"} chat_id=${ctx.chat?.id ?? "?"}`,
      );
      return;
    }
    // First-time authorized user: drop a default app-config block so they have
    // something to edit (and the watcher picks up further hand-edits).
    await users.ensure(userId).catch((err) => {
      void logError("error.users_ensure", err, { userId });
      console.warn(`[users] ensure(${userId}) failed:`, err);
    });
    await next();
  });

  function kickOffTurnFromContext(
    ctx: Context,
    chatId: string,
    prompt: string,
    opts: KickOffFromCtxOptions = {},
  ): void {
    const userId = ctx.from?.id;
    if (userId === undefined) return; // auth middleware already rejected
    const io = ioFromContext(ctx);
    const { attachments, traceStart, inputWasVoice } = opts;
    engine.kickOffTurn(io, chatId, userId, prompt, {
      ...(attachments ? { attachments } : {}),
      ...(traceStart !== undefined ? { traceStart } : {}),
      ...(inputWasVoice ? { inputWasVoice: true } : {}),
    });
  }

  registerCommands(bot, {
    config,
    bootTime,
    kickOffTurn: kickOffTurnFromContext,
    abortTurn: engine.abortTurn,
  });
  registerTelegramActions(bot);
  registerMediaHandlers(bot, { config, kickOffTurn: kickOffTurnFromContext });

  bot.on(message("text"), async (ctx) => {
    const chatId = String(ctx.chat.id);
    const text = ctx.message.text;
    if (text.startsWith("/")) return;
    if (!shouldRespond(ctx)) return;
    const prompt = buildReplyContext(ctx.message.reply_to_message) + text;
    kickOffTurnFromContext(ctx, chatId, prompt);
  });

  function kickOffTurnFromCron(
    chatId: string,
    userId: number | string,
    prompt: string,
    opts: KickOffOptions = {},
  ): void {
    const numericId = Number(chatId);
    if (!Number.isFinite(numericId)) {
      console.warn(
        `[cron] dropping fire for non-numeric chatId=${chatId} on telegram transport`,
      );
      return;
    }
    // Telegram convention: positive ids are user/DMs, negative ids are groups
    // and channels. Cron-fired turns need the right chatKind for the
    // scheduler-system-prompt's group/DM guidance and for `/respond` checks.
    const io = ioFromTelegram(
      bot.telegram,
      numericId,
      numericId < 0 ? "group" : "dm",
    );
    const triggerSource: TriggerSource = "cron";
    engine.kickOffTurn(io, chatId, userId, prompt, {
      ...opts,
      triggerSource,
    });
  }

  let cachedUsername: string | undefined;

  return {
    bot,
    async setMyCommands() {
      await bot.telegram
        .setMyCommands(COMMAND_MENU.map((c) => ({ ...c })))
        .catch((err) => console.warn("[boot] setMyCommands failed:", err));
    },
    async start() {
      const me = await bot.telegram.getMe();
      cachedUsername = me.username;
      console.log(`bot started as @${me.username}`);
      void bot.launch({ dropPendingUpdates: true }).catch((err) => {
        void logError("error.bot_launch", err);
        console.error("[telegram] launch error:", err);
      });
    },
    async stop(reason: string) {
      try {
        bot.stop(reason);
      } catch (err) {
        void logError("error.bot_stop", err);
      }
    },
    kickOffTurnFromCron,
    async notifyChat(chatId: string, text: string) {
      const numericId = Number(chatId);
      if (!Number.isFinite(numericId)) return;
      try {
        await bot.telegram.sendMessage(numericId, text);
      } catch {
        // ignore — chat may have blocked the bot or been deleted
      }
    },
    username: () => cachedUsername,
  };
}

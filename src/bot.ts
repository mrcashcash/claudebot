import { Telegraf, type Context } from "telegraf";
import { message, callbackQuery } from "telegraf/filters";
import type { Config } from "./config.ts";
import {
  askClaude,
  AskClaudeAbortedError,
  type AskClaudeAttachment,
} from "./services/claude.ts";
import * as sessions from "./state/sessions.ts";
import * as approvals from "./handlers/approvals.ts";
import * as questions from "./handlers/questions.ts";
import * as restartMarker from "./state/restart-marker.ts";
import * as busy from "./lifecycle/busy.ts";
import { ensureWhisperModel } from "./services/voice.ts";
import {
  registerCommands,
  effectiveWorkspace,
  effectiveMode,
} from "./handlers/commands.ts";
import {
  buildCanUseTool,
  handlePermissionCallback,
  safeAnswerCbQuery,
} from "./handlers/toolApprovals.ts";
import { registerMediaHandlers } from "./handlers/mediaHandlers.ts";

export { COMMAND_MENU } from "./handlers/commands.ts";

const TELEGRAM_MAX_TEXT = 4096;
const CHUNK_SIZE = 3500;
const TYPING_REFRESH_MS = 4000;
const BOOT_TIME = Date.now();

function chunk(text: string): string[] {
  if (text.length <= CHUNK_SIZE) return [text];
  const out: string[] = [];
  let remaining = text;
  while (remaining.length > CHUNK_SIZE) {
    let cut = remaining.lastIndexOf("\n", CHUNK_SIZE);
    if (cut < CHUNK_SIZE / 2) cut = CHUNK_SIZE;
    out.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n/, "");
  }
  if (remaining.length > 0) out.push(remaining);
  return out;
}

function startTypingLoop(ctx: Context): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      await ctx.sendChatAction("typing");
    } catch {
      // Telegram hiccup; ignore.
    }
  };
  void tick();
  const handle = setInterval(tick, TYPING_REFRESH_MS);
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}

export interface BuiltBot {
  bot: Telegraf;
  gracefulShutdown(reason: string): Promise<void>;
}

export function buildBot(config: Config): BuiltBot {
  // Telegraf's polling loop awaits each handler before fetching the next batch
  // of updates. Long-running turns (which can include an AskUserQuestion that
  // waits for a button click) must NOT be awaited inside a handler, or the bot
  // becomes deaf to new callback_queries — including the very click that would
  // unblock the turn. We dispatch turns with `void runTurn(...)` instead, so
  // each handler returns in milliseconds and the default handlerTimeout (90s)
  // is plenty.
  const bot = new Telegraf(config.telegramBotToken);
  bot.catch((err, ctx) => {
    console.error(
      `[bot] handler error for update ${ctx.update.update_id}:`,
      err,
    );
  });
  const inFlightChats = new Set<number>();
  const turnControllers = new Map<number, AbortController>();
  let lastActiveChat: number | null = null;
  let shuttingDown = false;

  if (config.voice.enabled && config.voice.preloadModel) {
    void ensureWhisperModel(config.voice.whisperModel)
      .then(() =>
        console.log(
          `[voice] preloaded whisper model: ${config.voice.whisperModel}`,
        ),
      )
      .catch((err) => console.error("[voice] preload failed:", err));
  }

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId === undefined || !config.allowedUserIds.has(userId)) {
      console.warn(
        `[auth] rejected update_id=${ctx.update.update_id} type=${ctx.updateType} user_id=${userId ?? "unknown"} chat_id=${ctx.chat?.id ?? "?"}`,
      );
      return;
    }
    await next();
  });

  registerCommands(bot, { config, bootTime: BOOT_TIME, kickOffTurn });

  bot.on(callbackQuery("data"), async (ctx) => {
    const data = ctx.callbackQuery.data;
    console.log(
      `[cb] received user=${ctx.from?.id} chat=${ctx.chat?.id} data="${data}"`,
    );

    if (data.startsWith("q:")) {
      const outcome = await questions.handleClick(data);
      if (outcome) {
        await safeAnswerCbQuery(ctx, outcome.toast);
        if (!outcome.ok) {
          try {
            await ctx.editMessageReplyMarkup(undefined);
          } catch {
            // ignore
          }
        }
      } else {
        await safeAnswerCbQuery(ctx);
      }
      return;
    }

    if (await handlePermissionCallback(ctx, data)) return;

    await safeAnswerCbQuery(ctx);
  });

  function kickOffTurn(
    ctx: Context,
    chatId: number,
    prompt: string,
    attachments?: AskClaudeAttachment[],
    /**
     * Optional wall-clock anchor (ms since epoch) for upstream latency.
     * The voice/audio handler passes the moment the message arrived so the
     * end-of-turn log can report total voice-to-final-reply duration.
     */
    traceStart?: number,
  ): void {
    // Fire-and-forget: see the handlerTimeout comment in buildBot. runTurn
    // owns its own error handling; this catch is only a safety net.
    void runTurn(ctx, chatId, prompt, attachments, traceStart).catch((err) => {
      console.error(`[turn] background error chat=${chatId}:`, err);
    });
  }

  async function runTurn(
    ctx: Context,
    chatId: number,
    prompt: string,
    attachments?: AskClaudeAttachment[],
    traceStart?: number,
  ): Promise<void> {
    if (shuttingDown) {
      await ctx.reply(
        "🔄 Bot is restarting due to a code change. Try again in a moment.",
      );
      return;
    }

    const previous = turnControllers.get(chatId);
    if (previous) {
      previous.abort();
      console.log(
        `[turn] chat=${chatId} cancelling previous turn (superseded)`,
      );
      try {
        await ctx.reply("⏹️ Previous turn cancelled — starting new one.");
      } catch {
        // ignore
      }
    }

    const controller = new AbortController();
    turnControllers.set(chatId, controller);

    const state = sessions.get(chatId);
    const stopTyping = startTypingLoop(ctx);
    const canUseTool = buildCanUseTool(ctx, chatId, controller.signal);
    inFlightChats.add(chatId);
    void busy.acquire();
    lastActiveChat = chatId;

    const turnStart = Date.now();
    const promptPreview = prompt.slice(0, 80).replace(/\s+/g, " ");
    const sessionTag = state.sessionId ? state.sessionId.slice(0, 8) : "new";
    const attachTag =
      attachments && attachments.length > 0 ? ` +${attachments.length}img` : "";
    const modelTag = state.model || "default";
    const modeTag = effectiveMode(state, config);
    console.log(
      `[turn] start chat=${chatId} session=${sessionTag} model=${modelTag} mode=${modeTag}${attachTag} prompt="${promptPreview}${prompt.length > 80 ? "…" : ""}"`,
    );

    try {
      const tAskStart = Date.now();
      const reply = await askClaude(prompt, {
        resumeSessionId: state.sessionId,
        cwd: effectiveWorkspace(state, config),
        permissionMode: effectiveMode(state, config),
        model: state.model,
        canUseTool,
        chatId,
        signal: controller.signal,
        // Persist the SDK's session_id immediately so an aborted/killed turn
        // can still be resumed from the same session next time.
        onSessionId: async (sid) => {
          await sessions.update(chatId, { sessionId: sid });
        },
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      });
      const claudeMs = Date.now() - tAskStart;
      await sessions.update(chatId, {
        sessionId: reply.sessionId || state.sessionId,
        totalCostUsd: (state.totalCostUsd ?? 0) + reply.costUsd,
      });

      const body =
        reply.text.length > 0
          ? reply.text
          : "(Claude returned an empty response)";
      const tReplyStart = Date.now();
      for (const part of chunk(body)) {
        await ctx.reply(part.slice(0, TELEGRAM_MAX_TEXT));
      }
      const replyMs = Date.now() - tReplyStart;
      const totalMs = Date.now() - turnStart;
      const traceTail =
        traceStart !== undefined
          ? ` voice-to-end=${Date.now() - traceStart}ms`
          : "";
      console.log(
        `[turn] end chat=${chatId} session=${(reply.sessionId || state.sessionId || "").slice(0, 8) || "new"} ` +
          `claude=${claudeMs}ms reply=${replyMs}ms total=${totalMs}ms${traceTail}`,
      );
    } catch (err) {
      if (err instanceof AskClaudeAbortedError || controller.signal.aborted) {
        // Cancellation is intentional; the new turn already replied.
        return;
      }
      console.error("[claude] error handling message:", err);
      try {
        await ctx.reply(
          `Error talking to Claude: ${err instanceof Error ? err.message : String(err)}`,
        );
      } catch {
        // Bot may already be shutting down.
      }
    } finally {
      inFlightChats.delete(chatId);
      void busy.release();
      stopTyping();
      if (turnControllers.get(chatId) === controller) {
        turnControllers.delete(chatId);
      }
    }
  }

  registerMediaHandlers(bot, { config, kickOffTurn });

  bot.on(message("text"), async (ctx) => {
    const chatId = ctx.chat.id;
    const text = ctx.message.text;
    if (text.startsWith("/")) return;
    kickOffTurn(ctx, chatId, text);
  });

  async function gracefulShutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    // Mark restart intent first so resumed/new processes know there was a
    // pending reload, even if we end up forced-killed during the wait.
    const chatsForMarker = new Set<number>(inFlightChats);
    if (lastActiveChat !== null) chatsForMarker.add(lastActiveChat);
    await restartMarker
      .write({
        chats: [...chatsForMarker],
        reason,
        shutdownAt: Date.now(),
      })
      .catch((err) =>
        console.error("[shutdown] restart-marker write failed:", err),
      );

    // Wait for in-flight turns to finish naturally instead of aborting them.
    // This is what the user wants: when tsx watch reloads after Claude edits
    // its own code, let Claude finish the current turn (and the user finish
    // answering any AskUserQuestion) before tearing down. tsx watch will wait
    // for this process to exit before spawning the new one.
    const SHUTDOWN_DRAIN_MS = 30 * 60 * 1000; // 30 minutes max
    const inFlightAtStart = [...inFlightChats];
    if (inFlightAtStart.length > 0) {
      console.log(
        `[shutdown] ${reason} — waiting up to ${SHUTDOWN_DRAIN_MS / 60000}min for ${inFlightAtStart.length} in-flight turn(s) to finish`,
      );
      await Promise.allSettled(
        inFlightAtStart.map((id) =>
          bot.telegram.sendMessage(
            id,
            "🔄 Code change detected — bot will reload after this turn finishes. Sit tight.",
          ),
        ),
      );
      const deadline = Date.now() + SHUTDOWN_DRAIN_MS;
      while (inFlightChats.size > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
      }
      if (inFlightChats.size > 0) {
        console.warn(
          `[shutdown] ${inFlightChats.size} turn(s) still running after ${SHUTDOWN_DRAIN_MS / 60000}min; aborting`,
        );
        for (const ctrl of turnControllers.values()) ctrl.abort();
        await Promise.allSettled(
          [...inFlightChats].map((id) =>
            bot.telegram.sendMessage(
              id,
              "⚠️ Bot has been waiting too long for your turn to finish — forcing reload now. Your in-flight request was cut short.",
            ),
          ),
        );
      } else {
        console.log(`[shutdown] all turns drained, restarting`);
      }
    } else {
      console.log(`[shutdown] ${reason} — no in-flight turns, restarting`);
    }

    turnControllers.clear();
    approvals.denyAll();
    questions.cancelAll();
    await busy.reset();

    try {
      bot.stop(reason);
    } catch {
      // ignore
    }
  }

  return { bot, gracefulShutdown };
}

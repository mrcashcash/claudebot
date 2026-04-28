import { Telegraf, type Context } from "telegraf";
import { message, callbackQuery } from "telegraf/filters";
import type { Config } from "./config.ts";
import {
  askClaude,
  AskClaudeAbortedError,
  type AskClaudeAttachment,
} from "./services/claude.ts";
import * as sessions from "./state/sessions.ts";
import * as users from "./state/users.ts";
import * as approvals from "./handlers/approvals.ts";
import * as questions from "./handlers/questions.ts";
import * as restartMarker from "./state/restart-marker.ts";
import * as busy from "./lifecycle/busy.ts";
import { registerCommands } from "./handlers/commands.ts";
import {
  buildCanUseTool,
  handlePermissionCallback,
  safeAnswerCbQuery,
  type TriggerSource,
} from "./handlers/toolApprovals.ts";
import { registerMediaHandlers } from "./handlers/mediaHandlers.ts";
import { ioFromContext, ioFromTelegram, type TurnIO } from "./handlers/turnIO.ts";
import {
  buildSchedulerMcp,
  buildSchedulerSystemGuidance,
} from "./scheduler/mcp.ts";
import { registerCronCommands } from "./handlers/cronCommands.ts";
import { log, logError } from "./state/logger.ts";

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

function startTypingLoop(io: TurnIO): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      await io.sendChatAction("typing");
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

export interface KickOffOptions {
  attachments?: AskClaudeAttachment[];
  /** Wall-clock anchor (ms since epoch) for upstream latency tracing. */
  traceStart?: number;
  /**
   * "user" (default) — turn was triggered by an incoming Telegram update.
   * "cron" — turn was fired by the scheduler; tool calls that aren't in
   * allowAlwaysTools are auto-denied (no inline buttons fire at 08:00 with
   * nobody watching).
   */
  triggerSource?: TriggerSource;
  /**
   * If `false`, ignore the chat's stored sessionId for this turn (fresh
   * session) and DON'T persist the new sessionId back. Used by cron jobs
   * with `resume: false` so the recurring fire doesn't pollute the chat's
   * interactive Claude session.
   */
  persistSession?: boolean;
}

export interface BuiltBot {
  bot: Telegraf;
  /** Fire a turn from outside a Telegraf handler (e.g., the cron ticker). */
  kickOffTurnFromCron(
    chatId: number,
    userId: number,
    prompt: string,
    opts?: KickOffOptions,
  ): void;
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
  const inFlightChats = new Set<number>();
  const turnControllers = new Map<number, AbortController>();
  // Per-chat FIFO queue: chained Promise tail. New messages append to the tail
  // so turns for the same chat run serially (oldest first). Replaces the
  // legacy "abort previous on new message" behavior — see `enqueueTurn`.
  const turnTails = new Map<number, Promise<void>>();
  let lastActiveChat: number | null = null;
  let shuttingDown = false;

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId === undefined || !config.allowedUserIds.has(userId)) {
      console.warn(
        `[auth] rejected update_id=${ctx.update.update_id} type=${ctx.updateType} user_id=${userId ?? "unknown"} chat_id=${ctx.chat?.id ?? "?"}`,
      );
      return;
    }
    // First-time authorized user: drop a default app-config file so they have
    // something to edit (and the watcher picks up further hand-edits).
    await users.ensure(userId).catch((err) => {
      void logError("error.users_ensure", err, { userId });
      console.warn(`[users] ensure(${userId}) failed:`, err);
    });
    await next();
  });

  registerCommands(bot, {
    config,
    bootTime: BOOT_TIME,
    kickOffTurn: kickOffTurnFromContext,
    abortTurn: (chatId: number, reason?: string): boolean => {
      const ctrl = turnControllers.get(chatId);
      if (!ctrl) return false;
      ctrl.abort(reason ?? "abort");
      return true;
    },
  });
  registerCronCommands(bot);

  function userIdFromCtx(ctx: Context): number | undefined {
    return ctx.from?.id;
  }

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

  function kickOffTurnFromContext(
    ctx: Context,
    chatId: number,
    prompt: string,
    attachments?: AskClaudeAttachment[],
    traceStart?: number,
  ): void {
    const userId = userIdFromCtx(ctx);
    if (userId === undefined) return; // auth middleware already rejected
    const io = ioFromContext(ctx);
    kickOffTurn(io, chatId, userId, prompt, {
      ...(attachments ? { attachments } : {}),
      ...(traceStart !== undefined ? { traceStart } : {}),
    });
  }

  function kickOffTurn(
    io: TurnIO,
    chatId: number,
    userId: number,
    prompt: string,
    opts: KickOffOptions = {},
  ): void {
    const triggerSource: TriggerSource = opts.triggerSource ?? "user";
    const queueDepth = turnTails.has(chatId) ? 1 : 0;
    void log({
      category: "turn",
      event: "turn.kickoff",
      chatId,
      userId,
      promptChars: prompt.length,
      source: triggerSource,
      queueDepth,
      attachments: opts.attachments?.length ?? 0,
    });
    // Enqueue onto the chat's serial tail Promise: a new message waits for any
    // already-running (or already-queued) turn for the same chat to finish
    // before its own runTurn starts. Different chats run in parallel as
    // before. The tail Promise's `.catch` swallows errors so one failed turn
    // can't poison the chain for the next message.
    const prev = turnTails.get(chatId) ?? Promise.resolve();
    const next = prev.then(() =>
      runTurn(io, chatId, userId, prompt, opts).catch((err) => {
        void logError("error.turn_tail", err, { chatId });
        console.error(`[turn] background error chat=${chatId}:`, err);
      }),
    );
    turnTails.set(chatId, next);
    void next.finally(() => {
      // Tail cleanup: only delete if we're still the latest in the chain.
      // Otherwise a later enqueueTurn already replaced us and is waiting on us.
      if (turnTails.get(chatId) === next) turnTails.delete(chatId);
    });
  }

  async function runTurn(
    io: TurnIO,
    chatId: number,
    userId: number,
    prompt: string,
    opts: KickOffOptions,
  ): Promise<void> {
    const triggerSource: TriggerSource = opts.triggerSource ?? "user";
    const persistSession = opts.persistSession ?? true;

    if (shuttingDown) {
      try {
        await io.reply(
          "🔄 Bot is restarting due to a code change. Try again in a moment.",
        );
      } catch {
        // ignore
      }
      return;
    }

    // Turns for the same chat run serially via `kickOffTurn`'s queue, so
    // there's nothing to "supersede" here. The only path that aborts a
    // running turn is `/new` and `/cancel` (via `abortTurn` in CommandDeps).
    const controller = new AbortController();
    turnControllers.set(chatId, controller);

    const state = sessions.get(chatId);
    const stopTyping = startTypingLoop(io);
    const canUseTool = buildCanUseTool(io, chatId, controller.signal, triggerSource);
    inFlightChats.add(chatId);
    void busy.acquire();
    lastActiveChat = chatId;

    const turnStart = Date.now();
    const promptPreview = prompt.slice(0, 80).replace(/\s+/g, " ");
    // When persistSession is false (cron fresh-session), force a new SDK session
    // by not passing resumeSessionId. Otherwise reuse the chat's stored session.
    const resumeSessionId = persistSession ? state.sessionId : undefined;
    const sessionTag = resumeSessionId ? resumeSessionId.slice(0, 8) : "new";
    const attachTag =
      opts.attachments && opts.attachments.length > 0
        ? ` +${opts.attachments.length}img`
        : "";
    const effectiveModel = users.effectiveModel(chatId, userId);
    const modelTag = effectiveModel || "default";
    const modeTag = users.effectiveMode(chatId, userId);
    const triggerTag = triggerSource === "cron" ? " trigger=cron" : "";
    console.log(
      `[turn] start chat=${chatId} user=${userId} session=${sessionTag} model=${modelTag} mode=${modeTag}${attachTag}${triggerTag} prompt="${promptPreview}${prompt.length > 80 ? "…" : ""}"`,
    );
    const cwdResolved = users.effectiveWorkspace(chatId, userId, config.gatewayDir);
    void log({
      category: "turn",
      event: "turn.start",
      chatId,
      userId,
      sessionId: resumeSessionId,
      model: modelTag,
      permissionMode: modeTag,
      workspace: cwdResolved,
      source: triggerSource,
      persistSession,
    });

    try {
      const tAskStart = Date.now();
      const tz = users.tzFor(userId);
      const schedulerServer = buildSchedulerMcp(chatId, userId, tz);
      const cwd = users.effectiveWorkspace(chatId, userId, config.gatewayDir);
      // Always expose <gatewayDir>/.claude/skills/ to the turn, even when the
      // chat has overridden its workspace. The SDK loads .claude/skills/ from
      // additionalDirectories per the skills docs. Skip when cwd already is
      // the gateway dir (would be a no-op duplicate).
      const additionalDirectories =
        cwd === config.gatewayDir ? undefined : [config.gatewayDir];
      const baseAsk = {
        cwd,
        permissionMode: users.effectiveMode(chatId, userId),
        ...(effectiveModel ? { model: effectiveModel } : {}),
        canUseTool,
        chatId,
        signal: controller.signal,
        mcpServers: { scheduler: schedulerServer },
        appendSystemPrompt: buildSchedulerSystemGuidance(tz, userId, chatId),
        ...(additionalDirectories ? { additionalDirectories } : {}),
        // Persist the SDK's session_id immediately so a killed turn can still
        // be resumed from the same session next time — but only when this
        // turn is allowed to take over the chat's session AND hasn't been
        // aborted (otherwise a late init message could re-instate a sessionId
        // that `/new` just cleared).
        onSessionId: async (sid: string) => {
          if (persistSession && !controller.signal.aborted) {
            await sessions.update(chatId, { sessionId: sid });
          }
        },
        ...(opts.attachments && opts.attachments.length > 0
          ? { attachments: opts.attachments }
          : {}),
      };
      let reply;
      try {
        reply = await askClaude(prompt, {
          ...(resumeSessionId ? { resumeSessionId } : {}),
          ...baseAsk,
        });
      } catch (err) {
        // The SDK stores conversation transcripts under the cwd's `.claude/`
        // dir, so a session created in workspace A can't be resumed when the
        // user later switches to workspace B. (We hit this when /workspace or
        // a Claude-driven config edit changes workspaceDir.) Drop the stale
        // resume id and retry once with a fresh session — same prompt, same
        // user-visible turn.
        const msg = err instanceof Error ? err.message : String(err);
        if (
          resumeSessionId &&
          !controller.signal.aborted &&
          /No conversation found with session ID/i.test(msg)
        ) {
          void log({
            category: "turn",
            event: "turn.workspace_recovery",
            chatId,
            sessionId: resumeSessionId,
            reason: "no_conversation_found",
          });
          console.warn(
            `[turn] chat=${chatId} resume failed (workspace likely changed) — retrying fresh`,
          );
          if (persistSession) {
            await sessions.update(chatId, { sessionId: undefined });
          }
          try {
            await io.reply(
              "🆕 Starting a fresh Claude session — your previous session lived in a different workspace.",
            );
          } catch {
            // ignore
          }
          reply = await askClaude(prompt, baseAsk);
        } else {
          throw err;
        }
      }
      const claudeMs = Date.now() - tAskStart;
      if (persistSession) {
        await sessions.update(chatId, {
          sessionId: reply.sessionId || state.sessionId,
          totalCostUsd: (state.totalCostUsd ?? 0) + reply.costUsd,
        });
      } else {
        // Still tally cost — the user is paying for it.
        await sessions.update(chatId, {
          totalCostUsd: (state.totalCostUsd ?? 0) + reply.costUsd,
        });
      }

      const body =
        reply.text.length > 0
          ? reply.text
          : "(Claude returned an empty response)";
      const tReplyStart = Date.now();
      const chunks = chunk(body);
      for (const part of chunks) {
        await io.reply(part.slice(0, TELEGRAM_MAX_TEXT));
      }
      const replyMs = Date.now() - tReplyStart;
      const totalMs = Date.now() - turnStart;
      const traceTail =
        opts.traceStart !== undefined
          ? ` voice-to-end=${Date.now() - opts.traceStart}ms`
          : "";
      console.log(
        `[turn] end chat=${chatId} session=${(reply.sessionId || resumeSessionId || "").slice(0, 8) || "new"} ` +
          `claude=${claudeMs}ms reply=${replyMs}ms total=${totalMs}ms${traceTail}`,
      );
      void log({
        category: "turn",
        event: "turn.end",
        chatId,
        userId,
        sessionId: reply.sessionId || resumeSessionId,
        durationMs: totalMs,
        claudeMs,
        replyMs,
        totalCostUsd: reply.costUsd,
        replyChars: body.length,
        chunks: chunks.length,
        source: triggerSource,
      });
    } catch (err) {
      if (err instanceof AskClaudeAbortedError || controller.signal.aborted) {
        const reason = controller.signal.aborted
          ? typeof controller.signal.reason === "string"
            ? controller.signal.reason
            : "aborted"
          : "ask_claude_aborted";
        void log({
          category: "turn",
          event: "turn.abort",
          chatId,
          userId,
          sessionId: resumeSessionId,
          cause: reason,
          durationMs: Date.now() - turnStart,
        });
        // Cancellation is intentional; the new turn already replied.
        return;
      }
      void logError("error.turn", err, {
        chatId,
        userId,
        sessionId: resumeSessionId,
      });
      void log({
        category: "turn",
        event: "turn.error",
        chatId,
        userId,
        sessionId: resumeSessionId,
        durationMs: Date.now() - turnStart,
        message: err instanceof Error ? err.message : String(err),
      });
      console.error("[claude] error handling message:", err);
      try {
        await io.reply(
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

  function kickOffTurnFromCron(
    chatId: number,
    userId: number,
    prompt: string,
    opts: KickOffOptions = {},
  ): void {
    const io = ioFromTelegram(bot.telegram, chatId);
    kickOffTurn(io, chatId, userId, prompt, {
      triggerSource: "cron",
      ...opts,
    });
  }

  registerMediaHandlers(bot, { config, kickOffTurn: kickOffTurnFromContext });

  bot.on(message("text"), async (ctx) => {
    const chatId = ctx.chat.id;
    const text = ctx.message.text;
    if (text.startsWith("/")) return;
    kickOffTurnFromContext(ctx, chatId, text);
  });

  async function gracefulShutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    const shutdownStart = Date.now();

    // Mark restart intent first so resumed/new processes know there was a
    // pending reload, even if we end up forced-killed during the wait.
    const chatsForMarker = new Set<number>(inFlightChats);
    if (lastActiveChat !== null) chatsForMarker.add(lastActiveChat);
    void log({
      category: "lifecycle",
      event: "lifecycle.shutdown.start",
      reason,
      affectedChats: [...chatsForMarker],
      inFlightCount: inFlightChats.size,
    });
    await restartMarker
      .write({
        chats: [...chatsForMarker],
        reason,
        shutdownAt: Date.now(),
      })
      .catch((err) => {
        void logError("error.restart_marker_write", err);
        console.error("[shutdown] restart-marker write failed:", err);
      });

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
        void log({
          category: "lifecycle",
          event: "lifecycle.shutdown.drain_timeout",
          pendingChats: [...inFlightChats],
          waitedMs: SHUTDOWN_DRAIN_MS,
        });
        console.warn(
          `[shutdown] ${inFlightChats.size} turn(s) still running after ${SHUTDOWN_DRAIN_MS / 60000}min; aborting`,
        );
        for (const ctrl of turnControllers.values()) ctrl.abort("shutdown");
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

    const forcedAbort = inFlightChats.size > 0;
    turnControllers.clear();
    approvals.denyAll();
    questions.cancelAll();
    await busy.reset();

    try {
      bot.stop(reason);
    } catch (err) {
      void logError("error.bot_stop", err);
    }
    void log({
      category: "lifecycle",
      event: "lifecycle.shutdown.complete",
      reason,
      durationMs: Date.now() - shutdownStart,
      forcedAbort,
    });
  }

  return { bot, kickOffTurnFromCron, gracefulShutdown };
}

import type { Config } from "../config.ts";
import {
  askClaude,
  AskClaudeAbortedError,
  type AskClaudeAttachment,
} from "../services/claude.ts";
import * as sessions from "../state/sessions.ts";
import * as users from "../state/users.ts";
import * as approvals from "../handlers/approvals.ts";
import * as questionsMod from "../handlers/questions.ts";
import * as busy from "../lifecycle/busy.ts";
import {
  buildCanUseTool,
  type TriggerSource,
} from "../handlers/toolApprovals.ts";
import { createStreamingReply } from "../handlers/streamingReply.ts";
import type { TurnIO } from "../handlers/turnIO.ts";
import { synthesize, TtsConfigError } from "../services/voice/tts.ts";
import {
  buildSchedulerMcp,
  buildSchedulerSystemGuidance,
} from "../scheduler/mcp.ts";
import {
  buildSendFileMcp,
  buildSendFileSystemGuidance,
} from "../services/sendFileMcp.ts";
import { log, logError } from "../state/logger.ts";

const CHUNK_SIZE = 3500;
const TYPING_REFRESH_MS = 4000;

export interface KickOffOptions {
  attachments?: AskClaudeAttachment[];
  /** Wall-clock anchor (ms since epoch) for upstream latency tracing. */
  traceStart?: number;
  /**
   * "user" (default) — turn was triggered by an incoming user message.
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
  /**
   * True when the originating user message was a voice/audio note. Combines
   * with the user's voice.replyMode to decide whether to also synthesize the
   * reply as a voice message. Defaults to false.
   */
  inputWasVoice?: boolean;
}

/**
 * Transport-agnostic turn engine. Owns the per-chat queue, in-flight tracking,
 * abort controllers, and the runTurn loop. Each transport (Telegram, Slack)
 * builds its own incoming-message handlers and calls `engine.kickOffTurn(io,
 * chatId, userId, prompt, opts?)` with a transport-specific `TurnIO`.
 *
 * The engine never instantiates Telegraf or Slack Bolt directly — that lives
 * in `src/telegram/app.ts` and `src/slack/app.ts`.
 */
export interface TurnEngine {
  kickOffTurn(
    io: TurnIO,
    chatId: string,
    userId: number | string,
    prompt: string,
    opts?: KickOffOptions,
  ): void;
  abortTurn(chatId: string, reason?: string): boolean;
  isShuttingDown(): boolean;
  beginShutdown(): void;
  /** Snapshot of chats with an active turn at call time. */
  inFlightChats(): string[];
  /** Most recent chat id that ran a turn — used so the restart marker can
   *  notify someone even if no turn is currently in flight. */
  lastActiveChat(): string | null;
  /** Snapshot of all currently-queued tail Promises, for drain races. */
  turnTails(): Promise<void>[];
  /** Abort every in-flight turn (used at the end of shutdown drain). */
  abortAll(reason: string): void;
  /** Idempotent post-shutdown cleanup: deny pending approvals, cancel pending
   *  questions, release the busy sentinel. */
  finalize(): Promise<void>;
}

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

async function maybeSendVoiceReply(args: {
  io: TurnIO;
  chatId: string;
  userId: number | string;
  text: string;
  inputWasVoice: boolean;
}): Promise<void> {
  const voice = users.voiceFor(args.userId);
  if (!voice.tts.enabled) return;
  const should =
    voice.replyMode === "voice" ||
    (voice.replyMode === "auto" && args.inputWasVoice);
  if (!should) return;
  // Slack TTS isn't wired yet — skip on transports without sendVoice/sendAudio.
  if (!args.io.sendVoice || !args.io.sendAudio) return;
  if (args.text.length > voice.tts.maxChars) {
    console.log(
      `[tts] chat=${args.chatId} skipped: reply ${args.text.length} chars > maxChars ${voice.tts.maxChars}`,
    );
    return;
  }
  try {
    const t0 = Date.now();
    const result = await synthesize(args.text, voice.tts);
    const ttsMs = Date.now() - t0;
    if (result.format === "opus") {
      await args.io.sendVoice(result.audio, "reply.ogg");
    } else {
      await args.io.sendAudio(result.audio, "reply.mp3");
    }
    console.log(
      `[tts] chat=${args.chatId} synth=${ttsMs}ms bytes=${result.audio.length} fmt=${result.format} backend=${voice.tts.backend} model=${voice.tts.model}`,
    );
  } catch (err) {
    if (err instanceof TtsConfigError) {
      console.warn(`[tts] chat=${args.chatId} skipped: ${err.message}`);
    } else {
      console.error(`[tts] chat=${args.chatId} failed:`, err);
    }
  }
}

function startTypingLoop(io: TurnIO): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      await io.sendChatAction("typing");
    } catch {
      // Transport hiccup; ignore.
    }
  };
  void tick();
  const handle = setInterval(tick, TYPING_REFRESH_MS);
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}

export function buildTurnEngine(config: Config): TurnEngine {
  // Chat ids are stringified at the boundary so Slack channel ids ("C…") and
  // Telegram numeric ids share the same map keyspace without colliding.
  const inFlightChatsSet = new Set<string>();
  const turnControllers = new Map<string, AbortController>();
  // Per-chat FIFO queue: chained Promise tail. New messages append to the tail
  // so turns for the same chat run serially (oldest first). Different chats
  // run in parallel.
  const turnTailsMap = new Map<string, Promise<void>>();
  let lastActiveChat: string | null = null;
  let shuttingDown = false;

  function kickOffTurn(
    io: TurnIO,
    chatId: string,
    userId: number | string,
    prompt: string,
    opts: KickOffOptions = {},
  ): void {
    const triggerSource: TriggerSource = opts.triggerSource ?? "user";
    const queueDepth = turnTailsMap.has(chatId) ? 1 : 0;
    void log({
      category: "turn",
      event: "turn.kickoff",
      chatId,
      userId,
      promptChars: prompt.length,
      source: triggerSource,
      queueDepth,
      attachments: opts.attachments?.length ?? 0,
      transport: io.transport,
    });
    const prev = turnTailsMap.get(chatId) ?? Promise.resolve();
    const next = prev.then(() =>
      runTurn(io, chatId, userId, prompt, opts).catch((err) => {
        void logError("error.turn_tail", err, { chatId });
        console.error(`[turn] background error chat=${chatId}:`, err);
      }),
    );
    turnTailsMap.set(chatId, next);
    void next.finally(() => {
      if (turnTailsMap.get(chatId) === next) turnTailsMap.delete(chatId);
    });
  }

  function abortTurn(chatId: string, reason?: string): boolean {
    const ctrl = turnControllers.get(chatId);
    if (!ctrl) return false;
    ctrl.abort(reason ?? "abort");
    return true;
  }

  async function runTurn(
    io: TurnIO,
    chatId: string,
    userId: number | string,
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

    const controller = new AbortController();
    turnControllers.set(chatId, controller);

    const stopTyping = startTypingLoop(io);
    const canUseTool = buildCanUseTool(io, chatId, controller.signal, triggerSource);
    const stream = createStreamingReply(io);
    inFlightChatsSet.add(chatId);
    void busy.acquire();
    lastActiveChat = chatId;

    const turnStart = Date.now();
    const promptPreview = prompt.slice(0, 80).replace(/\s+/g, " ");
    const resumeSessionId = persistSession
      ? sessions.get(chatId).sessionId
      : undefined;
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
    const cwd = users.effectiveWorkspace(chatId, userId, config.gatewayDir);
    void log({
      category: "turn",
      event: "turn.start",
      chatId,
      userId,
      sessionId: resumeSessionId,
      model: modelTag,
      permissionMode: modeTag,
      workspace: cwd,
      source: triggerSource,
      persistSession,
      transport: io.transport,
    });

    try {
      const tAskStart = Date.now();
      const tz = users.tzFor(userId);
      const schedulerServer = buildSchedulerMcp(chatId, userId, tz, io.transport);
      const sendFileServer = buildSendFileMcp(io, cwd);
      const additionalDirectories =
        cwd === config.gatewayDir ? undefined : [config.gatewayDir];
      const baseAsk = {
        cwd,
        permissionMode: users.effectiveMode(chatId, userId),
        ...(effectiveModel ? { model: effectiveModel } : {}),
        canUseTool,
        chatId,
        signal: controller.signal,
        mcpServers: { scheduler: schedulerServer, claudebot: sendFileServer },
        appendSystemPrompt:
          buildSchedulerSystemGuidance(
            tz,
            userId,
            chatId,
            io.chatKind === "group",
          ) +
          "\n\n" +
          buildSendFileSystemGuidance(io.transport),
        ...(additionalDirectories ? { additionalDirectories } : {}),
        onTextDelta: (_delta: string, full: string) => stream.push(full),
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
      const fresh = sessions.get(chatId);
      if (persistSession) {
        await sessions.update(chatId, {
          sessionId: reply.sessionId || fresh.sessionId,
          totalCostUsd: (fresh.totalCostUsd ?? 0) + reply.costUsd,
        });
      } else {
        await sessions.update(chatId, {
          totalCostUsd: (fresh.totalCostUsd ?? 0) + reply.costUsd,
        });
      }

      const body =
        reply.text.length > 0
          ? reply.text
          : "(Claude returned an empty response)";
      const tReplyStart = Date.now();
      const chunks = chunk(body);
      await stream.finalize(chunks);
      const replyMs = Date.now() - tReplyStart;
      if (reply.text.length > 0) {
        await maybeSendVoiceReply({
          io,
          chatId,
          userId,
          text: reply.text,
          inputWasVoice: opts.inputWasVoice === true,
        });
      }
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
        if (stream.hasPlaceholder()) {
          await stream.fail("⏹️ Cancelled.").catch(() => {});
        }
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
      const errText = `Error talking to Claude: ${err instanceof Error ? err.message : String(err)}`;
      try {
        if (stream.hasPlaceholder()) {
          await stream.fail(errText);
        } else {
          await io.reply(errText);
        }
      } catch {
        // Bot may already be shutting down.
      }
    } finally {
      inFlightChatsSet.delete(chatId);
      void busy.release();
      stopTyping();
      if (turnControllers.get(chatId) === controller) {
        turnControllers.delete(chatId);
      }
    }
  }

  return {
    kickOffTurn,
    abortTurn,
    isShuttingDown: () => shuttingDown,
    beginShutdown: () => {
      shuttingDown = true;
    },
    inFlightChats: () => [...inFlightChatsSet],
    lastActiveChat: () => lastActiveChat,
    turnTails: () => [...turnTailsMap.values()],
    abortAll: (reason: string) => {
      for (const ctrl of turnControllers.values()) ctrl.abort(reason);
    },
    finalize: async () => {
      turnControllers.clear();
      approvals.denyAll();
      questionsMod.cancelAll();
      await busy.reset();
    },
  };
}

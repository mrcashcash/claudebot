import {
  query,
  type Options,
  type CanUseTool,
  type HookCallbackMatcher,
  type HookInput,
  type AsyncHookJSONOutput,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { PermissionMode } from "../config.ts";
import * as turnLog from "../state/turnLog.ts";

export interface ClaudeReply {
  text: string;
  sessionId: string;
  costUsd: number;
}

export interface AskClaudeAttachment {
  type: "image";
  mediaType: string;
  base64: string;
}

export interface AskClaudeOptions {
  resumeSessionId?: string;
  cwd: string;
  permissionMode: PermissionMode;
  model?: string;
  canUseTool?: CanUseTool;
  chatId?: number;
  attachments?: AskClaudeAttachment[];
  signal?: AbortSignal;
  // Called the moment we learn the SDK's session_id (system init message).
  // Lets the caller persist it immediately so an aborted/killed turn can still
  // be resumed from the same Claude session on the next message.
  onSessionId?: (sessionId: string) => void | Promise<void>;
}

export class AskClaudeAbortedError extends Error {
  constructor() {
    super("askClaude aborted");
    this.name = "AskClaudeAbortedError";
  }
}

function buildHooks(chatId: number | undefined): Options["hooks"] {
  if (chatId === undefined) return undefined;

  const fireAndForget = (record: turnLog.TurnRecord): void => {
    void turnLog.append(record).catch((err) => {
      console.warn("[turnLog] append failed:", err);
    });
  };

  const preMatcher: HookCallbackMatcher = {
    hooks: [
      async (input: HookInput): Promise<AsyncHookJSONOutput> => {
        if (input.hook_event_name === "PreToolUse") {
          console.log(
            `[tool] chat=${chatId} → ${input.tool_name} (${input.tool_use_id.slice(0, 8)})`,
          );
          fireAndForget({
            ts: Date.now(),
            kind: "pre",
            chatId,
            sessionId: input.session_id,
            toolUseID: input.tool_use_id,
            tool: input.tool_name,
            input: input.tool_input,
          });
        }
        return { async: true };
      },
    ],
  };

  const postMatcher: HookCallbackMatcher = {
    hooks: [
      async (input: HookInput): Promise<AsyncHookJSONOutput> => {
        if (input.hook_event_name === "PostToolUse") {
          const dur = input.duration_ms ? ` ${input.duration_ms}ms` : "";
          console.log(
            `[tool] chat=${chatId} ✓ ${input.tool_name} (${input.tool_use_id.slice(0, 8)})${dur}`,
          );
          fireAndForget({
            ts: Date.now(),
            kind: "post",
            chatId,
            sessionId: input.session_id,
            toolUseID: input.tool_use_id,
            tool: input.tool_name,
            response: input.tool_response,
            durationMs: input.duration_ms,
          });
        }
        return { async: true };
      },
    ],
  };

  const postFailMatcher: HookCallbackMatcher = {
    hooks: [
      async (input: HookInput): Promise<AsyncHookJSONOutput> => {
        if (input.hook_event_name === "PostToolUseFailure") {
          console.warn(
            `[tool] chat=${chatId} ✗ ${input.tool_name} (${input.tool_use_id.slice(0, 8)}): ${input.error}`,
          );
          fireAndForget({
            ts: Date.now(),
            kind: "post_failure",
            chatId,
            sessionId: input.session_id,
            toolUseID: input.tool_use_id,
            tool: input.tool_name,
            response: input.error,
          });
        }
        return { async: true };
      },
    ],
  };

  return {
    PreToolUse: [preMatcher],
    PostToolUse: [postMatcher],
    PostToolUseFailure: [postFailMatcher],
  };
}

function buildPrompt(
  text: string,
  attachments: AskClaudeAttachment[] | undefined,
): string | AsyncIterable<SDKUserMessage> {
  if (!attachments || attachments.length === 0) return text;

  async function* gen(): AsyncIterable<SDKUserMessage> {
    yield {
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          ...(text ? [{ type: "text" as const, text }] : []),
          ...attachments!.map((a) => ({
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: a.mediaType as
                | "image/jpeg"
                | "image/png"
                | "image/gif"
                | "image/webp",
              data: a.base64,
            },
          })),
        ],
      },
    };
  }
  return gen();
}

export async function askClaude(
  prompt: string,
  opts: AskClaudeOptions,
): Promise<ClaudeReply> {
  const hooks = buildHooks(opts.chatId);
  const options: Options = {
    cwd: opts.cwd,
    permissionMode: opts.permissionMode,
    ...(opts.resumeSessionId ? { resume: opts.resumeSessionId } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.canUseTool ? { canUseTool: opts.canUseTool } : {}),
    ...(hooks ? { hooks } : {}),
  };

  let assistantText = "";
  let sessionId = opts.resumeSessionId ?? "";
  let costUsd = 0;

  const promptInput = buildPrompt(prompt, opts.attachments);
  const q = query({ prompt: promptInput, options });

  let abortListener: (() => void) | undefined;
  if (opts.signal) {
    if (opts.signal.aborted) {
      q.close();
      throw new AskClaudeAbortedError();
    }
    abortListener = () => {
      try {
        q.close();
      } catch {
        // ignore
      }
    };
    opts.signal.addEventListener("abort", abortListener, { once: true });
  }

  try {
    for await (const m of q) {
      if (opts.signal?.aborted) break;
      if (m.type === "system" && m.subtype === "init") {
        sessionId = m.session_id;
        if (opts.onSessionId) {
          try {
            await opts.onSessionId(sessionId);
          } catch (err) {
            console.warn("[claude] onSessionId callback failed:", err);
          }
        }
      } else if (m.type === "assistant") {
        for (const block of m.message.content) {
          if (block.type === "text") assistantText += block.text;
        }
      } else if (m.type === "result") {
        const anyM = m as {
          result?: string;
          total_cost_usd?: number;
          session_id?: string;
        };
        if (anyM.result && anyM.result.length > 0) assistantText = anyM.result;
        if (typeof anyM.total_cost_usd === "number") costUsd = anyM.total_cost_usd;
        if (anyM.session_id) sessionId = anyM.session_id;
      }
    }
  } finally {
    if (opts.signal && abortListener) {
      opts.signal.removeEventListener("abort", abortListener);
    }
  }

  if (opts.signal?.aborted) throw new AskClaudeAbortedError();
  return { text: assistantText.trim(), sessionId, costUsd };
}

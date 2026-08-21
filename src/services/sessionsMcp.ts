import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  describeSession,
  findExistingSession,
  listSessions,
  projectsDirFor,
  searchSessions,
} from "./claudeSessions.ts";
import { askClaude, AskClaudeAbortedError } from "./claude.ts";
import * as sessions from "../state/sessions.ts";
import { log, logError } from "../state/logger.ts";

/**
 * Cross-session tools. Claude Code transcripts for a workspace all live in
 * `~/.claude/projects/<slug>/`, so from inside one turn we can (a) enumerate
 * and grep the chat's other sessions and (b) *fork* one of them and ask it a
 * question — a sub-agent that already holds that conversation's context and
 * reports back, without the live turn losing its own context.
 *
 * The fork is the important part: `resume` alone would append the sub-agent's
 * exchange to the target transcript. `forkSession: true` branches into a fresh
 * session id, so peeking is non-destructive.
 */

/** Tools the peek sub-agent may use. Read-only: it reports, it never edits. */
const PEEK_TOOLS = ["Read", "Grep", "Glob"];
const PEEK_MAX_TURNS = 12;
const PEEK_MAX_BUDGET_USD = 1.5;
const PEEK_ANSWER_MAX_CHARS = 8000;

/** `mcp__sessions__*` tools that only read the filesystem — safe to auto-allow. */
export const SESSIONS_READONLY_TOOLS = new Set([
  "mcp__sessions__session_list",
  "mcp__sessions__session_search",
]);

export function buildSessionsSystemGuidance(): string {
  return `Other Claude Code sessions for this workspace are readable from this turn via the \`mcp__sessions__*\` tools, and each chat has exactly one live session at a time.

- \`session_list\` — recent sessions for this workspace (id, age, size, first prompt).
- \`session_search\` — case-insensitive substring search across recent transcripts. Use this to locate WHICH past session discussed something.
- \`session_ask\` — fork a past session and ask it a question. This spawns a sub-agent that already holds that conversation's full context and returns a briefing. The fork is non-destructive: the original transcript is untouched, and YOUR session is unaffected.

Reach for \`session_ask\` when the user refers to work you have no record of ("like we did yesterday", "the fix from the other chat", "what did we decide about X") and \`session_search\` has pointed you at a likely session. Prefer it over re-deriving the answer from scratch by re-reading half the repo. Don't use it for facts already in this conversation, and don't use it to delegate new work — it is read-only and reports context back.

The user can also switch this chat's live session by sending a bare session id (or an 8-char prefix) as a message — no slash command. If they paste an id, they mean "switch", and the gateway handles it before the message ever reaches you.`;
}

const ok = (text: string) => ({
  content: [{ type: "text" as const, text }],
});
const err = (text: string) => ({
  content: [{ type: "text" as const, text }],
  isError: true,
});

function ageString(ms: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function sizeString(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}

/**
 * Permission gate for the peek sub-agent. `tools` already strips everything
 * outside PEEK_TOOLS from its context; this is the backstop for anything that
 * slips through (MCP tools inherited from user-scope config, for instance).
 */
function peekCanUseTool(): CanUseTool {
  return async (toolName, input): Promise<PermissionResult> => {
    if (PEEK_TOOLS.includes(toolName)) {
      return { behavior: "allow", updatedInput: input };
    }
    return {
      behavior: "deny",
      message: `Session-peek sub-agents are read-only; ${toolName} is not available. Answer from this conversation's context using ${PEEK_TOOLS.join(" / ")}.`,
    };
  };
}

function peekPrompt(question: string): string {
  return `[Context request from another Claude session — read-only]

Another Claude session working in this same workspace needs information that lives in THIS conversation. You are being forked purely to report; nothing you say continues the work here, and you must not modify anything. Only ${PEEK_TOOLS.join(" / ")} are available if you need to verify a file path or a line of code.

Question: ${question}

Reply with a concise self-contained briefing (bullets, under 300 words). Include the concrete details the asker cannot re-derive cheaply: file paths, ids, commands, decisions and the reasons behind them, and anything that was tried and rejected. If this conversation genuinely doesn't cover the question, say so in one line instead of guessing.`;
}

export interface SessionsMcpArgs {
  chatId: string;
  /** Resolved workspace for the turn — scopes which transcripts are visible. */
  workspaceDir: string;
  model?: string;
  /** The turn's abort signal, so /cancel kills an in-flight peek. */
  signal: AbortSignal;
  /** The chat's live session id, if any — peeking at it is a no-op. */
  currentSessionId?: string;
}

export function buildSessionsMcp(args: SessionsMcpArgs) {
  const { chatId, workspaceDir, model, signal, currentSessionId } = args;

  return createSdkMcpServer({
    name: "sessions",
    version: "1.0.0",
    tools: [
      tool(
        "session_list",
        `List recent Claude Code sessions for the current workspace (${workspaceDir}), newest first, with each session's id, last-activity age, transcript size and first user prompt. Read-only.`,
        {
          limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .describe("How many sessions to return. Default 10."),
        },
        async ({ limit }) => {
          const list = await listSessions(workspaceDir, limit ?? 10);
          if (list.length === 0) {
            return ok(
              `No sessions found in ${projectsDirFor(workspaceDir)} — no Claude Code session has ever run for this workspace on this machine.`,
            );
          }
          const lines = list.map((s) => {
            const marker = s.id === currentSessionId ? " [CURRENT]" : "";
            const head = `${s.id} · ${ageString(s.mtimeMs)} · ${sizeString(s.sizeBytes)}${marker}`;
            return s.preview ? `${head}\n    ${clip(s.preview, 160)}` : head;
          });
          return ok(
            `${list.length} session(s) for ${workspaceDir}:\n\n${lines.join("\n")}`,
          );
        },
      ),
      tool(
        "session_search",
        "Case-insensitive substring search across the text of recent session transcripts for this workspace. Use it to find WHICH past session discussed something before calling session_ask. Searches user and assistant messages only (not tool output). Read-only.",
        {
          query: z
            .string()
            .min(2)
            .describe("Substring to look for, e.g. a filename, error text or feature name."),
          sessions: z
            .number()
            .int()
            .min(1)
            .max(40)
            .optional()
            .describe("How many recent sessions to scan. Default 15."),
          perSession: z
            .number()
            .int()
            .min(1)
            .max(10)
            .optional()
            .describe("Max snippets per matching session. Default 3."),
        },
        async ({ query, sessions: scanCount, perSession }) => {
          const hits = await searchSessions(workspaceDir, query, {
            ...(scanCount !== undefined ? { sessions: scanCount } : {}),
            ...(perSession !== undefined ? { perSession } : {}),
          });
          if (hits.length === 0) {
            return ok(
              `No transcript matches for "${query}" in the recent sessions of ${workspaceDir}. Try a shorter or different term, or raise \`sessions\`.`,
            );
          }
          const blocks = hits.map((h) => {
            const marker = h.id === currentSessionId ? " [CURRENT]" : "";
            const head = `${h.id} · ${ageString(h.mtimeMs)}${marker}${h.preview ? `\n    opened with: ${clip(h.preview, 120)}` : ""}`;
            const ms = h.matches
              .map((m) => `    [${m.role}] ${clip(m.snippet, 320)}`)
              .join("\n");
            return `${head}\n${ms}`;
          });
          return ok(
            `${hits.length} session(s) mention "${query}":\n\n${blocks.join("\n\n")}`,
          );
        },
      ),
      tool(
        "session_ask",
        `Fork a past session of this workspace and ask it a question. Spawns a sub-agent that already holds that conversation's full context, gives it ${PEEK_TOOLS.join(" / ")} only, and returns its briefing. Non-destructive: the target transcript is not modified and your own session is unaffected. Costs tokens (capped at $${PEEK_MAX_BUDGET_USD}), so ask one well-scoped question rather than several vague ones.`,
        {
          session: z
            .string()
            .min(6)
            .describe(
              "Target session id, or an unambiguous hex prefix (6+ chars) as shown by session_list / session_search.",
            ),
          question: z
            .string()
            .min(5)
            .describe(
              "What you need from that conversation. Be specific — the sub-agent cannot see your conversation, so include any context the question depends on.",
            ),
        },
        async ({ session, question }) => {
          if (signal.aborted) return err("Turn was cancelled.");
          const found = await findExistingSession(workspaceDir, session);
          if (found === "ambiguous") {
            return err(
              `Prefix "${session}" matches more than one session. Use more characters (session_list shows full ids).`,
            );
          }
          if (!found) {
            return err(
              `No session matching "${session}" in ${projectsDirFor(workspaceDir)}. Call session_list to see what exists for this workspace.`,
            );
          }
          if (currentSessionId && found.id === currentSessionId) {
            return err(
              "That is the session you are already running in — answer from your own context instead of forking yourself.",
            );
          }
          const t0 = Date.now();
          void log({
            category: "turn",
            event: "session_ask.start",
            chatId,
            sessionId: found.id,
            questionChars: question.length,
          });
          try {
            const reply = await askClaude(peekPrompt(question), {
              resumeSessionId: found.id,
              forkSession: true,
              cwd: workspaceDir,
              // Always "default" regardless of the chat's mode: bypassPermissions
              // would skip canUseTool entirely, and a peek must stay read-only
              // no matter how permissive the chat is.
              permissionMode: "default",
              ...(model ? { model } : {}),
              // `tools` removes everything else from the sub-agent's context;
              // canUseTool is the backstop for anything that slips in (e.g.
              // user-scope MCP servers). Deliberately NOT using allowedTools —
              // bare entries there auto-approve before the callback runs.
              tools: PEEK_TOOLS,
              canUseTool: peekCanUseTool(),
              // Drop user/local settings so their `permissions.allow` rules
              // and user-scope MCP servers can't pre-approve tools behind
              // canUseTool's back. "project" stays so CLAUDE.md still loads.
              settingSources: ["project"],
              maxTurns: PEEK_MAX_TURNS,
              maxBudgetUsd: PEEK_MAX_BUDGET_USD,
              signal,
            });
            // Bill the peek to the chat. The outer turn re-reads state after
            // askClaude returns, so this write lands first and isn't clobbered.
            const state = sessions.get(chatId);
            await sessions.update(chatId, {
              totalCostUsd: (state.totalCostUsd ?? 0) + reply.costUsd,
            });
            void log({
              category: "turn",
              event: "session_ask.end",
              chatId,
              sessionId: found.id,
              durationMs: Date.now() - t0,
              costUsd: reply.costUsd,
              replyChars: reply.text.length,
            });
            if (reply.text.length === 0) {
              return err(
                `Session ${found.id.slice(0, 8)} returned nothing (it may have hit the ${PEEK_MAX_TURNS}-turn or $${PEEK_MAX_BUDGET_USD} cap). Try a narrower question.`,
              );
            }
            const answer =
              reply.text.length > PEEK_ANSWER_MAX_CHARS
                ? reply.text.slice(0, PEEK_ANSWER_MAX_CHARS) +
                  `\n…(truncated, +${reply.text.length - PEEK_ANSWER_MAX_CHARS} chars)`
                : reply.text;
            return ok(
              `Briefing from session ${found.id} (last active ${ageString(found.mtimeMs)}` +
                `${found.preview ? `, opened with: "${clip(found.preview, 100)}"` : ""}` +
                `; cost $${reply.costUsd.toFixed(4)}):\n\n${answer}`,
            );
          } catch (e) {
            if (e instanceof AskClaudeAbortedError || signal.aborted) {
              return err("Peek cancelled — the turn was aborted.");
            }
            void logError("error.session_ask", e, { chatId, sessionId: found.id });
            return err(
              `Could not ask session ${found.id.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        },
      ),
    ],
  });
}

import { Markup, type Context } from "telegraf";
import type {
  CanUseTool,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import * as sessions from "../state/sessions.ts";
import * as approvals from "./approvals.ts";
import * as questions from "./questions.ts";
import type { TurnIO } from "./turnIO.ts";
import { log, logError } from "../state/logger.ts";

function inputSummary(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input).slice(0, 500);
  } catch {
    return "[unserializable]";
  }
}

const TELEGRAM_MAX_TEXT = 4096;
const PROMPT_MAX = 3500;

export type TriggerSource = "user" | "cron";

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…(+${s.length - max} chars)`;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

function formatToolPrompt(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const lines: string[] = [`🔧 Claude wants to run *${toolName}*`];
  switch (toolName) {
    case "Bash": {
      const cmd = asString(input.command);
      const desc = input.description ? asString(input.description) : "";
      lines.push("```\n" + truncate(cmd, 1500) + "\n```");
      if (desc) lines.push(`_${desc}_`);
      break;
    }
    case "Write": {
      lines.push(`📄 \`${asString(input.file_path)}\``);
      const content = asString(input.content);
      lines.push("```\n" + truncate(content, 1200) + "\n```");
      break;
    }
    case "Edit":
    case "MultiEdit": {
      lines.push(`📄 \`${asString(input.file_path)}\``);
      if (input.old_string !== undefined) {
        lines.push("− old:");
        lines.push(
          "```\n" + truncate(asString(input.old_string), 600) + "\n```",
        );
        lines.push("+ new:");
        lines.push(
          "```\n" + truncate(asString(input.new_string), 600) + "\n```",
        );
      } else if (Array.isArray(input.edits)) {
        lines.push(`(${input.edits.length} edits)`);
      }
      break;
    }
    case "AskUserQuestion": {
      // Will be auto-denied; this branch is for completeness if we ever route it.
      lines.push("(clarifying question — auto-handled)");
      break;
    }
    default: {
      lines.push(
        "```json\n" + truncate(JSON.stringify(input, null, 2), 1500) + "\n```",
      );
    }
  }
  return truncate(lines.join("\n"), PROMPT_MAX);
}

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

function createPermissionKeyboard(toolUseId: string) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("✅ Allow", `perm:allow:once:${toolUseId}`),
      Markup.button.callback("✅ Always", `perm:allow:always:${toolUseId}`),
    ],
    [
      Markup.button.callback("❌ Deny", `perm:deny:once:${toolUseId}`),
      Markup.button.callback("❌ Never", `perm:deny:always:${toolUseId}`),
    ],
  ]);
}

function ruleMatches(toolName: string, rules: string[] | undefined): boolean {
  if (!rules || rules.length === 0) return false;
  return rules.includes(toolName);
}

function isAskUserQuestionInput(
  input: Record<string, unknown>,
): input is { questions: questions.QuestionDef[] } {
  if (!Array.isArray((input as { questions?: unknown }).questions))
    return false;
  for (const q of (input as { questions: unknown[] }).questions) {
    if (
      !q ||
      typeof q !== "object" ||
      typeof (q as { question?: unknown }).question !== "string" ||
      !Array.isArray((q as { options?: unknown }).options)
    ) {
      return false;
    }
  }
  return true;
}

export function buildCanUseTool(
  io: TurnIO,
  chatId: number,
  turnSignal: AbortSignal,
  triggerSource: TriggerSource = "user",
): CanUseTool {
  return async (toolName, input, options): Promise<PermissionResult> => {
    const toolUseId = options.toolUseID;

    // Auto-allow our own scheduler tools — they only mutate data/crons.json.
    // Actual prompts they schedule still go through normal approvals when they
    // fire, with their own triggerSource=cron in effect.
    if (toolName.startsWith("mcp__scheduler__")) {
      void log({
        category: "approval",
        event: "approval.auto_allow",
        chatId,
        tool: toolName,
        toolUseId,
        reason: "scheduler_mcp",
      });
      return { behavior: "allow", updatedInput: input };
    }

    if (toolName === "AskUserQuestion") {
      // Cron-fired turns have no human reader to answer questions.
      if (triggerSource === "cron") {
        void log({
          category: "approval",
          event: "approval.auto_deny",
          chatId,
          tool: toolName,
          toolUseId,
          reason: "cron_no_human",
        });
        return {
          behavior: "deny",
          message:
            "Cron-fired turns cannot ask the user questions. Phrase the prompt with all the info needed up front, or schedule a different prompt.",
        };
      }
      if (!isAskUserQuestionInput(input)) {
        void log({
          category: "approval",
          event: "approval.auto_deny",
          chatId,
          tool: toolName,
          toolUseId,
          reason: "askquestion_bad_shape",
        });
        return {
          behavior: "deny",
          message:
            "AskUserQuestion input was not in the expected shape; ask the question in free-form chat instead.",
        };
      }
      try {
        const answers = await questions.ask(
          io,
          toolUseId,
          input.questions,
          turnSignal,
        );
        if (turnSignal.aborted) {
          void log({
            category: "approval",
            event: "approval.askquestion_aborted",
            chatId,
            toolUseId,
            reason: "turn_aborted",
          });
          return {
            behavior: "deny",
            message: "Turn cancelled.",
          };
        }
        void log({
          category: "approval",
          event: "approval.askquestion_answered",
          chatId,
          toolUseId,
          questionsCount: input.questions.length,
          answers,
        });
        return {
          behavior: "allow",
          updatedInput: {
            questions: input.questions,
            answers,
          },
        };
      } catch (err) {
        void logError("error.askquestion", err, { chatId, toolUseId });
        console.error("[questions] failed:", err);
        return {
          behavior: "deny",
          message: `Failed to collect answers: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    const state = sessions.get(chatId);
    if (ruleMatches(toolName, state.denyAlwaysTools)) {
      void log({
        category: "approval",
        event: "approval.auto_deny",
        chatId,
        tool: toolName,
        toolUseId,
        reason: "always_deny",
        inputSummary: inputSummary(input),
      });
      return {
        behavior: "deny",
        message: `User has set ${toolName} to always-deny in this chat.`,
      };
    }
    if (ruleMatches(toolName, state.allowAlwaysTools)) {
      void log({
        category: "approval",
        event: "approval.auto_allow",
        chatId,
        tool: toolName,
        toolUseId,
        reason: "always_allow",
        inputSummary: inputSummary(input),
      });
      return { behavior: "allow", updatedInput: input };
    }

    // Cron-fired turns must not block waiting for inline-button approval —
    // there's no one watching at 08:00. Auto-deny anything not pre-approved.
    if (triggerSource === "cron") {
      void log({
        category: "approval",
        event: "approval.auto_deny",
        chatId,
        tool: toolName,
        toolUseId,
        reason: "cron_no_human",
        inputSummary: inputSummary(input),
      });
      return {
        behavior: "deny",
        message:
          `Cron-fired turn cannot prompt for ${toolName}. Pre-approve it via /rules ` +
          `(send the prompt interactively first and tap "Always") so the next fire works.`,
      };
    }

    const text = formatToolPrompt(toolName, input);
    try {
      await io.reply(text, {
        parse_mode: "Markdown",
        ...createPermissionKeyboard(toolUseId),
      });
    } catch {
      await io.reply(
        text.replace(/[*_`]/g, ""),
        createPermissionKeyboard(toolUseId),
      );
    }
    void log({
      category: "approval",
      event: "approval.prompted",
      chatId,
      tool: toolName,
      toolUseId,
      inputSummary: inputSummary(input),
    });

    return await new Promise<PermissionResult>((resolve) => {
      approvals.register(toolUseId, async (choice) => {
        if (choice.scope === "always") {
          const fresh = sessions.get(chatId);
          if (choice.decision === "allow") {
            const next = Array.from(
              new Set([...(fresh.allowAlwaysTools ?? []), toolName]),
            );
            await sessions.update(chatId, { allowAlwaysTools: next });
          } else {
            const next = Array.from(
              new Set([...(fresh.denyAlwaysTools ?? []), toolName]),
            );
            await sessions.update(chatId, { denyAlwaysTools: next });
          }
        }
        if (choice.decision === "allow") {
          resolve({ behavior: "allow", updatedInput: input });
        } else {
          resolve({
            behavior: "deny",
            message: "User denied this tool call via Telegram.",
          });
        }
      });
      const cancel = (msg: string) => {
        if (approvals.isPending(toolUseId)) {
          approvals.unregister(toolUseId);
          resolve({ behavior: "deny", message: msg });
        }
      };
      options.signal.addEventListener("abort", () =>
        cancel("Tool call aborted."),
      );
      turnSignal.addEventListener("abort", () =>
        cancel("Turn cancelled by a newer message."),
      );
    });
  };
}

export async function handlePermissionCallback(
  ctx: Context,
  data: string,
): Promise<boolean> {
  const permMatch = data.match(/^perm:(allow|deny):(once|always):(.+)$/);
  if (!permMatch) return false;

  const decision = permMatch[1] as approvals.Decision;
  const scope = permMatch[2] as approvals.Scope;
  const toolUseId = permMatch[3]!;
  const settled = approvals.settle(toolUseId, { decision, scope });
  void log({
    category: "approval",
    event: "approval.decision",
    chatId: ctx.chat?.id,
    userId: ctx.from?.id,
    toolUseId,
    decision: scope === "always" ? `always_${decision}` : decision,
    settled,
  });

  const cbLabel =
    decision === "allow"
      ? scope === "always"
        ? "Allowed (always)"
        : "Allowed"
      : scope === "always"
        ? "Denied (always)"
        : "Denied";
  await safeAnswerCbQuery(ctx, cbLabel);
  try {
    const suffix =
      decision === "allow"
        ? scope === "always"
          ? "\n\n✅ *Allowed* (always for this chat)"
          : "\n\n✅ *Allowed*"
        : scope === "always"
          ? "\n\n❌ *Denied* (always for this chat)"
          : "\n\n❌ *Denied*";
    const original =
      ctx.callbackQuery?.message && "text" in ctx.callbackQuery.message
        ? ctx.callbackQuery.message.text
        : "";
    await ctx.editMessageText(truncate(original + suffix, TELEGRAM_MAX_TEXT), {
      parse_mode: "Markdown",
    });
  } catch {
    try {
      await ctx.editMessageReplyMarkup(undefined);
    } catch {
      // ignore
    }
  }

  if (!settled) {
    await ctx.reply("(That request already expired or was already answered.)");
  }
  return true;
}

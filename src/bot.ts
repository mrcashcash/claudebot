import { Telegraf, Markup, type Context } from "telegraf";
import { message, callbackQuery } from "telegraf/filters";
import type {
  CanUseTool,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs/promises";
import path from "node:path";
import type { Config, PermissionMode } from "./config.ts";
import { VALID_PERMISSION_MODES } from "./config.ts";
import {
  askClaude,
  AskClaudeAbortedError,
  type AskClaudeAttachment,
} from "./claude.ts";
import * as sessions from "./sessions.ts";
import type { ChatState } from "./sessions.ts";
import * as approvals from "./approvals.ts";
import * as questions from "./questions.ts";
import * as restartMarker from "./restart-marker.ts";
import * as busy from "./busy.ts";
import { transcribeAudio, ensureWhisperModel } from "./voice.ts";

export const MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-4-7",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
  default: "",
};

// Shortcut → canonical PermissionMode. Keys are lowercased; the handler
// lowercases user input before looking up. Keep canonical names here too so
// the exact spelling still works.
export const MODE_ALIASES: Record<string, PermissionMode> = {
  default: "default",
  acceptedits: "acceptEdits",
  accept: "acceptEdits",
  acc: "acceptEdits",
  edits: "acceptEdits",
  bypasspermissions: "bypassPermissions",
  bypass: "bypassPermissions",
  byp: "bypassPermissions",
  yolo: "bypassPermissions",
  plan: "plan",
};

export const COMMAND_MENU = [
  { command: "help", description: "Show available commands" },
  { command: "status", description: "Workspace, model, session, cost" },
  {
    command: "model",
    description: "Switch model: opus / sonnet / haiku / default",
  },
  {
    command: "mode",
    description:
      "Permission mode: default / acceptEdits / bypassPermissions / plan",
  },
  {
    command: "workspace",
    description: "Set Claude's working directory for this chat",
  },
  {
    command: "cloudexpert",
    description: "Quick set workspace to D:\\cloudexpert",
  },
  {
    command: "init",
    description: "Ask Claude to analyze the workspace and write CLAUDE.md",
  },
  {
    command: "compact",
    description: "Summarize and continue from a compact form",
  },
  { command: "resume", description: "Resume a specific session id" },
  { command: "clear", description: "Clear this chat's memory" },
  { command: "reset", description: "Alias for /clear" },
  { command: "cost", description: "Show cumulative cost for this chat" },
  {
    command: "rules",
    description: "List always-allow / always-deny tool rules",
  },
] as const;

const TELEGRAM_MAX_TEXT = 4096;
const CHUNK_SIZE = 3500;
const PROMPT_MAX = 3500;
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

async function safeAnswerCbQuery(ctx: Context, text?: string): Promise<void> {
  try {
    await ctx.answerCbQuery(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Telegram returns 400 if the callback query is older than ~15s (e.g.
    // after a bot restart with buffered updates). Nothing actionable.
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

function permissionKeyboard(toolUseId: string) {
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

function buildCanUseTool(
  ctx: Context,
  chatId: number,
  turnSignal: AbortSignal,
): CanUseTool {
  return async (toolName, input, options): Promise<PermissionResult> => {
    const toolUseId = options.toolUseID;

    if (toolName === "AskUserQuestion") {
      if (!isAskUserQuestionInput(input)) {
        return {
          behavior: "deny",
          message:
            "AskUserQuestion input was not in the expected shape; ask the question in free-form chat instead.",
        };
      }
      try {
        const answers = await questions.ask(
          ctx,
          chatId,
          toolUseId,
          input.questions,
          turnSignal,
        );
        if (turnSignal.aborted) {
          return {
            behavior: "deny",
            message: "Turn cancelled.",
          };
        }
        return {
          behavior: "allow",
          updatedInput: {
            questions: input.questions,
            answers,
          },
        };
      } catch (err) {
        console.error("[questions] failed:", err);
        return {
          behavior: "deny",
          message: `Failed to collect answers: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    const state = sessions.get(chatId);
    if (ruleMatches(toolName, state.denyAlwaysTools)) {
      return {
        behavior: "deny",
        message: `User has set ${toolName} to always-deny in this chat.`,
      };
    }
    if (ruleMatches(toolName, state.allowAlwaysTools)) {
      return { behavior: "allow", updatedInput: input };
    }

    const text = formatToolPrompt(toolName, input);
    try {
      await ctx.reply(text, {
        parse_mode: "Markdown",
        ...permissionKeyboard(toolUseId),
      });
    } catch {
      // Markdown parse failures fall back to plain text.
      await ctx.reply(
        text.replace(/[*_`]/g, ""),
        permissionKeyboard(toolUseId),
      );
    }

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

  const helpText =
    "*Telegram → Claude Code gateway*\n" +
    "Send any text and Claude works in `" +
    config.workspaceDir +
    "` by default.\n" +
    "You can also send *photos* (Claude sees them), *documents* (saved to `.uploads/` for Claude to read), " +
    "and *voice messages* (transcribed locally with Whisper, no cloud).\n" +
    "When Claude wants to run a tool you'll see Allow / Always / Deny / Never buttons.\n\n" +
    "*Commands*\n" +
    COMMAND_MENU.map((c) => `/${c.command} — ${c.description}`).join("\n");

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

  const sendHelp = async (ctx: Context): Promise<void> => {
    try {
      await ctx.reply(helpText, { parse_mode: "Markdown" });
    } catch {
      await ctx.reply(helpText.replace(/[*`]/g, ""));
    }
  };

  bot.start(sendHelp);
  bot.help(sendHelp);
  bot.command("help", sendHelp);

  const handleClear = async (ctx: Context): Promise<void> => {
    if (ctx.chat) await sessions.clear(ctx.chat.id);
    await ctx.reply("🧹 Memory cleared. Next message starts a fresh session.");
  };
  bot.command("clear", handleClear);
  bot.command("reset", handleClear);
  bot.command("new", handleClear);

  bot.command("cost", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const state = sessions.get(chatId);
    const cost = state.totalCostUsd ?? 0;
    await ctx.reply(`💰 Cumulative cost for this chat: $${cost.toFixed(4)}`);
  });

  const effectiveWorkspace = (state: ChatState): string =>
    state.workspaceDir ?? config.workspaceDir;
  const effectiveMode = (state: ChatState): PermissionMode =>
    state.permissionMode ?? config.permissionMode;

  bot.command("status", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const state = sessions.get(chatId);
    const model =
      state.model && state.model.length > 0 ? state.model : "(SDK default)";
    const session = state.sessionId
      ? state.sessionId.slice(0, 8) + "…"
      : "(none)";
    const cost = (state.totalCostUsd ?? 0).toFixed(4);
    const wsTag = state.workspaceDir ? "(override)" : "(default)";
    const modeTag = state.permissionMode ? "(override)" : "(default)";
    const allowCount = state.allowAlwaysTools?.length ?? 0;
    const denyCount = state.denyAlwaysTools?.length ?? 0;
    const lines = [
      `*Workspace:* \`${effectiveWorkspace(state)}\` ${wsTag}`,
      `*Permission mode:* ${effectiveMode(state)} ${modeTag}`,
      `*Model:* ${model}`,
      `*Session:* ${session}`,
      `*Cost:* $${cost}`,
      `*Always rules:* ${allowCount} allow / ${denyCount} deny`,
      `*Booted:* ${new Date(BOOT_TIME).toISOString()}`,
    ];
    try {
      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
    } catch {
      await ctx.reply(lines.join("\n").replace(/[*`]/g, ""));
    }
  });

  bot.command("mode", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const arg = ctx.message.text.split(/\s+/).slice(1).join(" ").trim();
    const argLower = arg.toLowerCase();
    if (!arg) {
      const state = sessions.get(chatId);
      const choices = [...VALID_PERMISSION_MODES].join(", ");
      await ctx.reply(
        `Current permission mode: ${effectiveMode(state)} ${state.permissionMode ? "(override)" : "(default)"}\n` +
          `Usage: /mode <${choices}>\n` +
          `Shortcuts: acc/accept/edits → acceptEdits, byp/bypass/yolo → bypassPermissions\n` +
          `Or: /mode reset — clear the override`,
      );
      return;
    }
    if (argLower === "reset" || argLower === "default-reset") {
      await sessions.update(chatId, { permissionMode: undefined });
      await ctx.reply(
        `✅ Permission mode override cleared. Effective: ${config.permissionMode}.`,
      );
      return;
    }
    const resolved = MODE_ALIASES[argLower];
    if (!resolved) {
      await ctx.reply(
        `Unknown mode "${arg}". Choose: ${[...VALID_PERMISSION_MODES].join(", ")}\n` +
          `Shortcuts: acc/accept/edits, byp/bypass/yolo, plan, default.`,
      );
      return;
    }
    await sessions.update(chatId, { permissionMode: resolved });
    await ctx.reply(`✅ Permission mode for this chat set to *${resolved}*.`, {
      parse_mode: "Markdown",
    });
  });

  bot.command("workspace", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const arg = ctx.message.text.split(/\s+/).slice(1).join(" ").trim();
    if (!arg) {
      const state = sessions.get(chatId);
      await ctx.reply(
        `Current workspace: \`${effectiveWorkspace(state)}\` ${state.workspaceDir ? "(override)" : "(default)"}\n` +
          `Usage: /workspace <absolute-path>\n` +
          `Or: /workspace reset — clear the override`,
        { parse_mode: "Markdown" },
      );
      return;
    }
    if (arg === "reset") {
      await sessions.update(chatId, { workspaceDir: undefined });
      await ctx.reply(
        `✅ Workspace override cleared. Effective: ${config.workspaceDir}.`,
      );
      return;
    }
    const resolved = path.resolve(arg);
    try {
      const stat = await fs.stat(resolved);
      if (!stat.isDirectory()) {
        await ctx.reply(`❌ Not a directory: ${resolved}`);
        return;
      }
    } catch {
      await ctx.reply(`❌ Path does not exist: ${resolved}`);
      return;
    }
    await sessions.update(chatId, { workspaceDir: resolved });
    await ctx.reply(`✅ Workspace for this chat set to \`${resolved}\`.`, {
      parse_mode: "Markdown",
    });
  });

  bot.command("cloudexpert", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const target = "D:\\cloudexpert";
    try {
      const stat = await fs.stat(target);
      if (!stat.isDirectory()) {
        await ctx.reply(`❌ Not a directory: ${target}`);
        return;
      }
    } catch {
      await ctx.reply(`❌ Path does not exist: ${target}`);
      return;
    }
    await sessions.update(chatId, { workspaceDir: target });
    await ctx.reply(`✅ Workspace for this chat set to \`${target}\`.`, {
      parse_mode: "Markdown",
    });
  });

  bot.command("init", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const prompt =
      "Analyze the codebase rooted at this working directory and create a CLAUDE.md file that documents:\n" +
      "- Project purpose and high-level architecture\n" +
      "- Key files and modules\n" +
      "- Build, run, test commands (from package.json or equivalent)\n" +
      "- Conventions and gotchas a new contributor should know\n\n" +
      "If CLAUDE.md already exists, update it rather than overwriting.";
    kickOffTurn(ctx, chatId, prompt);
  });

  bot.command("compact", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const prompt =
      "Compact our conversation: summarize what we have established so far, what we are currently working on, and any open questions, then continue from that summary.";
    kickOffTurn(ctx, chatId, prompt);
  });

  bot.command("resume", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const arg = ctx.message.text.split(/\s+/).slice(1).join(" ").trim();
    const state = sessions.get(chatId);
    if (!arg) {
      const current = state.sessionId ? state.sessionId : "(none)";
      await ctx.reply(
        `Current session: \`${current}\`\n` +
          `Usage: /resume <sessionId>\n` +
          `Or: /resume reset — start a new session next turn`,
        { parse_mode: "Markdown" },
      );
      return;
    }
    if (arg === "reset") {
      await sessions.update(chatId, { sessionId: undefined });
      await ctx.reply(
        "✅ Session cleared. Next message starts a fresh session.",
      );
      return;
    }
    if (!/^[0-9a-fA-F-]{8,}$/.test(arg)) {
      await ctx.reply(
        "❌ That doesn't look like a session id. Expected a UUID-like value.",
      );
      return;
    }
    await sessions.update(chatId, { sessionId: arg });
    await ctx.reply(`✅ Will resume session \`${arg}\` on next message.`, {
      parse_mode: "Markdown",
    });
  });

  bot.command("rules", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const arg = ctx.message.text.split(/\s+/).slice(1).join(" ").trim();
    const state = sessions.get(chatId);

    if (arg === "clear") {
      await sessions.update(chatId, {
        allowAlwaysTools: [],
        denyAlwaysTools: [],
      });
      await ctx.reply("🧹 Cleared all always-allow/deny rules for this chat.");
      return;
    }

    const allow = state.allowAlwaysTools ?? [];
    const deny = state.denyAlwaysTools ?? [];
    if (allow.length === 0 && deny.length === 0) {
      await ctx.reply(
        "No always-allow/deny rules set. Tap *Always* on a permission prompt to add one.\n" +
          "Use `/rules clear` to wipe them.",
        { parse_mode: "Markdown" },
      );
      return;
    }
    const lines = [
      "*Always-allow:*",
      ...(allow.length > 0 ? allow.map((t) => `  • ${t}`) : ["  _(none)_"]),
      "",
      "*Always-deny:*",
      ...(deny.length > 0 ? deny.map((t) => `  • ${t}`) : ["  _(none)_"]),
      "",
      "_/rules clear to wipe._",
    ];
    try {
      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
    } catch {
      await ctx.reply(lines.join("\n").replace(/[*_`]/g, ""));
    }
  });

  bot.command("model", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const arg = ctx.message.text
      .split(/\s+/)
      .slice(1)
      .join(" ")
      .trim()
      .toLowerCase();
    if (!arg) {
      const current = sessions.get(chatId).model || "(SDK default)";
      const choices = Object.keys(MODEL_ALIASES).join(", ");
      await ctx.reply(`Current model: ${current}\nUsage: /model <${choices}>`);
      return;
    }
    if (!(arg in MODEL_ALIASES)) {
      await ctx.reply(
        `Unknown model "${arg}". Choose: ${Object.keys(MODEL_ALIASES).join(", ")}`,
      );
      return;
    }
    const resolved = MODEL_ALIASES[arg]!;
    await sessions.update(chatId, { model: resolved || undefined });
    await ctx.reply(
      resolved
        ? `✅ Model for this chat set to \`${resolved}\` (${arg}).`
        : "✅ Model reset to SDK default.",
      { parse_mode: "Markdown" },
    );
  });

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

    const permMatch = /^perm:(allow|deny):(once|always):(.+)$/.exec(data);
    if (permMatch) {
      const decision = permMatch[1] as approvals.Decision;
      const scope = permMatch[2] as approvals.Scope;
      const toolUseId = permMatch[3]!;
      const settled = approvals.settle(toolUseId, { decision, scope });

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
          ctx.callbackQuery.message && "text" in ctx.callbackQuery.message
            ? ctx.callbackQuery.message.text
            : "";
        await ctx.editMessageText(
          truncate(original + suffix, TELEGRAM_MAX_TEXT),
          {
            parse_mode: "Markdown",
          },
        );
      } catch {
        try {
          await ctx.editMessageReplyMarkup(undefined);
        } catch {
          // ignore
        }
      }

      if (!settled) {
        await ctx.reply(
          "(That request already expired or was already answered.)",
        );
      }
      return;
    }

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
    const modeTag = effectiveMode(state);
    console.log(
      `[turn] start chat=${chatId} session=${sessionTag} model=${modelTag} mode=${modeTag}${attachTag} prompt="${promptPreview}${prompt.length > 80 ? "…" : ""}"`,
    );

    try {
      const tAskStart = Date.now();
      const reply = await askClaude(prompt, {
        resumeSessionId: state.sessionId,
        cwd: effectiveWorkspace(state),
        permissionMode: effectiveMode(state),
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

  async function downloadTelegramFile(fileId: string): Promise<Buffer> {
    const url = await bot.telegram.getFileLink(fileId);
    const r = await fetch(url.toString());
    if (!r.ok) throw new Error(`Telegram file fetch failed: ${r.status}`);
    const ab = await r.arrayBuffer();
    return Buffer.from(ab);
  }

  function sanitizeFilename(name: string): string {
    return name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
  }

  const IMAGE_MEDIA_TYPES = new Set([
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
  ]);
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

  bot.on(message("photo"), async (ctx) => {
    const chatId = ctx.chat.id;
    const sizes = ctx.message.photo;
    const largest = sizes[sizes.length - 1];
    if (!largest) {
      await ctx.reply("No photo data received.");
      return;
    }
    try {
      const buf = await downloadTelegramFile(largest.file_id);
      if (buf.byteLength > MAX_IMAGE_BYTES) {
        await ctx.reply(
          `❌ Image too large (${(buf.byteLength / 1024 / 1024).toFixed(1)} MB > 5 MB).`,
        );
        return;
      }
      const caption =
        typeof ctx.message.caption === "string" ? ctx.message.caption : "";
      const prompt = caption.length > 0 ? caption : "Describe this image.";
      const attachment: AskClaudeAttachment = {
        type: "image",
        mediaType: "image/jpeg",
        base64: buf.toString("base64"),
      };
      kickOffTurn(ctx, chatId, prompt, [attachment]);
    } catch (err) {
      console.error("[photo] failed:", err);
      await ctx.reply(
        `Error handling photo: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  bot.on(message("document"), async (ctx) => {
    const chatId = ctx.chat.id;
    const doc = ctx.message.document;
    const mime = doc.mime_type ?? "application/octet-stream";
    const caption =
      typeof ctx.message.caption === "string" ? ctx.message.caption : "";
    try {
      const buf = await downloadTelegramFile(doc.file_id);

      if (IMAGE_MEDIA_TYPES.has(mime)) {
        if (buf.byteLength > MAX_IMAGE_BYTES) {
          await ctx.reply(
            `❌ Image too large (${(buf.byteLength / 1024 / 1024).toFixed(1)} MB > 5 MB).`,
          );
          return;
        }
        const prompt = caption.length > 0 ? caption : "Describe this image.";
        const attachment: AskClaudeAttachment = {
          type: "image",
          mediaType: mime,
          base64: buf.toString("base64"),
        };
        kickOffTurn(ctx, chatId, prompt, [attachment]);
        return;
      }

      const state = sessions.get(chatId);
      const ws = effectiveWorkspace(state);
      const uploadsDir = path.join(ws, ".uploads");
      await fs.mkdir(uploadsDir, { recursive: true });
      const safeName = sanitizeFilename(doc.file_name ?? `${doc.file_id}.bin`);
      const filename = `${Date.now()}-${safeName}`;
      const dest = path.join(uploadsDir, filename);
      await fs.writeFile(dest, buf);

      const rel = path.relative(ws, dest).replace(/\\/g, "/");
      const prompt =
        `User uploaded a file at \`${rel}\` (mime: ${mime}, ${buf.byteLength} bytes).` +
        (caption ? `\nCaption: ${caption}` : "") +
        `\nUse Read or another appropriate tool to inspect it.`;
      kickOffTurn(ctx, chatId, prompt);
    } catch (err) {
      console.error("[document] failed:", err);
      await ctx.reply(
        `Error handling document: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  // Shared logic for voice + audio. Telegraf's `voice` and `audio` filters
  // expose slightly different shapes, so the caller passes the relevant
  // fields. Returns immediately (handler-must-return-fast convention) and
  // does the slow ffmpeg+whisper work fire-and-forget — without that, the
  // Telegraf polling loop would stall while a 30-second clip transcribes.
  type IncomingAudio = {
    fileId: string;
    fileUniqueId: string;
    durationSec: number;
    fileName: string | undefined;
    /** Human label for log + prompt prefix ("voice" or "audio"). */
    kind: "voice" | "audio";
  };

  const handleAudioMessage = (
    ctx: Context,
    chatId: number,
    audio: IncomingAudio,
    caption: string,
  ): void => {
    if (!config.voice.enabled) {
      void ctx.reply("Voice transcription is disabled (VOICE_ENABLED=false).");
      return;
    }
    if (audio.durationSec > config.voice.maxDurationSec) {
      void ctx.reply(
        `❌ ${audio.kind === "voice" ? "Voice message" : "Audio file"} too long (${audio.durationSec}s > ${config.voice.maxDurationSec}s).`,
      );
      return;
    }

    void (async () => {
      let placeholderId: number | undefined;
      const tArrival = Date.now();
      try {
        const placeholder = await ctx.reply("🎤 Transcribing…");
        placeholderId = placeholder.message_id;

        const tDownload = Date.now();
        const buf = await downloadTelegramFile(audio.fileId);
        const downloadMs = Date.now() - tDownload;
        const ws = effectiveWorkspace(sessions.get(chatId));
        const uploadsDir = path.join(ws, ".uploads");
        await fs.mkdir(uploadsDir, { recursive: true });

        const ext =
          audio.kind === "voice"
            ? ".ogg"
            : path.extname(audio.fileName ?? "") || ".bin";
        const safeStem = sanitizeFilename(
          audio.fileName
            ? path.basename(audio.fileName, path.extname(audio.fileName))
            : `${audio.kind}-${audio.fileUniqueId}`,
        );
        const filename = `${Date.now()}-${audio.kind}-${safeStem}${ext}`;
        const inputPath = path.join(uploadsDir, filename);
        await fs.writeFile(inputPath, buf);

        const tTranscribe = Date.now();
        const { text, timings } = await transcribeAudio({
          inputPath,
          model: config.voice.whisperModel,
          language: config.voice.language,
          ffmpegPath: config.voice.ffmpegPath,
        });
        const transcribeMs = Date.now() - tTranscribe;
        console.log(
          `[${audio.kind}] chat=${chatId} dur=${audio.durationSec}s ` +
            `download=${downloadMs}ms decode=${timings.decodeMs}ms ` +
            `pipeline=${timings.pipelineCached ? "cached" : "first-load"}(${timings.pipelineMs}ms) ` +
            `infer=${timings.inferMs}ms transcribe-total=${transcribeMs}ms`,
        );

        // Transcript is fed silently to Claude — drop the placeholder.
        if (placeholderId !== undefined) {
          await ctx.telegram
            .deleteMessage(chatId, placeholderId)
            .catch(() => {});
          placeholderId = undefined;
        }

        const transcript = text.trim();
        if (transcript.length === 0) {
          await ctx.reply(
            `🎤 Couldn't make out any speech in that ${audio.kind === "voice" ? "voice message" : "audio file"}.`,
          );
          return;
        }

        const prompt =
          `[User sent a ${audio.durationSec}s ${audio.kind} message. Transcript:]\n${transcript}` +
          (caption ? `\n\n[Caption: ${caption}]` : "");
        kickOffTurn(ctx, chatId, prompt, undefined, tArrival);
      } catch (err) {
        console.error(`[${audio.kind}] failed:`, err);
        const msg = `❌ Transcription failed: ${err instanceof Error ? err.message : String(err)}`;
        if (placeholderId !== undefined) {
          try {
            await ctx.telegram.editMessageText(
              chatId,
              placeholderId,
              undefined,
              msg,
            );
          } catch {
            await ctx.reply(msg);
          }
        } else {
          await ctx.reply(msg);
        }
      }
    })();
  };

  bot.on(message("voice"), (ctx) => {
    const chatId = ctx.chat.id;
    const v = ctx.message.voice;
    const caption =
      typeof ctx.message.caption === "string" ? ctx.message.caption : "";
    handleAudioMessage(
      ctx,
      chatId,
      {
        fileId: v.file_id,
        fileUniqueId: v.file_unique_id,
        durationSec: v.duration,
        fileName: undefined,
        kind: "voice",
      },
      caption,
    );
  });

  bot.on(message("audio"), (ctx) => {
    const chatId = ctx.chat.id;
    const a = ctx.message.audio;
    const caption =
      typeof ctx.message.caption === "string" ? ctx.message.caption : "";
    handleAudioMessage(
      ctx,
      chatId,
      {
        fileId: a.file_id,
        fileUniqueId: a.file_unique_id,
        durationSec: a.duration,
        fileName: a.file_name,
        kind: "audio",
      },
      caption,
    );
  });

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

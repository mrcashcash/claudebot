import { Telegraf, type Context } from "telegraf";
import fs from "node:fs/promises";
import path from "node:path";
import type { Config, PermissionMode } from "../config.ts";
import { VALID_PERMISSION_MODES } from "../config.ts";
import * as sessions from "../state/sessions.ts";
import type { ChatState } from "../state/sessions.ts";

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
  { command: "new", description: "Alias for /clear" },
  { command: "cost", description: "Show cumulative cost for this chat" },
  {
    command: "rules",
    description: "List always-allow / always-deny tool rules",
  },
] as const;

export const effectiveWorkspace = (
  state: ChatState,
  config: Config,
): string => state.workspaceDir ?? config.workspaceDir;

export const effectiveMode = (
  state: ChatState,
  config: Config,
): PermissionMode => state.permissionMode ?? config.permissionMode;

export interface CommandDeps {
  config: Config;
  bootTime: number;
  kickOffTurn: (ctx: Context, chatId: number, prompt: string) => void;
}

export function registerCommands(bot: Telegraf, deps: CommandDeps): void {
  const { config, bootTime, kickOffTurn } = deps;

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
      `*Workspace:* \`${effectiveWorkspace(state, config)}\` ${wsTag}`,
      `*Permission mode:* ${effectiveMode(state, config)} ${modeTag}`,
      `*Model:* ${model}`,
      `*Session:* ${session}`,
      `*Cost:* $${cost}`,
      `*Always rules:* ${allowCount} allow / ${denyCount} deny`,
      `*Booted:* ${new Date(bootTime).toISOString()}`,
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
        `Current permission mode: ${effectiveMode(state, config)} ${state.permissionMode ? "(override)" : "(default)"}\n` +
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
        `Current workspace: \`${effectiveWorkspace(state, config)}\` ${state.workspaceDir ? "(override)" : "(default)"}\n` +
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
}

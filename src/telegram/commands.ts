import { Telegraf, type Context } from "telegraf";
import type { Config } from "../config.ts";
import {
  runCommand,
  type CommandDeps,
} from "../handlers/commandRunner.ts";
import {
  COMMAND_MENU,
  type ChatKind,
} from "../handlers/commandShared.ts";
import { ioFromContext } from "./io.ts";

export { COMMAND_MENU } from "../handlers/commandShared.ts";

export interface TelegramCommandDeps {
  config: Config;
  bootTime: number;
  /** Fire a turn for the given chat. The TG-side adapter knows how to bridge ctx → kickOffTurn. */
  kickOffTurn: (ctx: Context, chatId: string, prompt: string) => void;
  abortTurn: (chatId: string, reason?: string) => boolean;
}

function chatKindOf(ctx: Context): ChatKind | null {
  if (!ctx.chat) return null;
  return ctx.chat.type === "private" ? "dm" : "group";
}

function buildDeps(
  ctx: Context,
  base: TelegramCommandDeps,
): CommandDeps | null {
  const userId = ctx.from?.id;
  const kind = chatKindOf(ctx);
  if (ctx.chat?.id === undefined || userId === undefined || kind === null) {
    return null;
  }
  const chatId = String(ctx.chat.id);
  return {
    config: base.config,
    bootTime: base.bootTime,
    io: ioFromContext(ctx),
    chatId,
    userId,
    chatKind: kind,
    kickOff: (prompt) => base.kickOffTurn(ctx, chatId, prompt),
    abort: (reason) => base.abortTurn(chatId, reason),
  };
}

export function registerCommands(bot: Telegraf, deps: TelegramCommandDeps): void {
  for (const c of COMMAND_MENU) {
    bot.command(c.command, async (ctx) => {
      const cd = buildDeps(ctx, deps);
      if (!cd) return;
      const text = "text" in ctx.message ? (ctx.message.text ?? "") : "";
      const args = text.split(/\s+/).slice(1);
      await runCommand(cd, c.command, args);
    });
  }

  // /help, /start — reuse the runner's help (it knows the transport).
  const sendHelp = async (ctx: Context): Promise<void> => {
    const cd = buildDeps(ctx, deps);
    if (!cd) return;
    await runCommand(cd, "help", []);
  };
  bot.start(sendHelp);
  bot.help(sendHelp);
}

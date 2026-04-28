import type { Config } from "../config.ts";
import {
  runCommand,
  isCommandName,
  type CommandDeps,
} from "../handlers/commandRunner.ts";
import type { TurnIO } from "../handlers/turnIO.ts";

/**
 * Slack-side command dispatcher. Matches the prefix of a posted message:
 * "/cmd args…". The actual per-command logic lives in
 * `handlers/commandRunner.ts` so Telegram and Slack stay in lockstep.
 *
 * Returns `true` if the message was a command (handled or rejected here);
 * `false` to let the caller fall through to a normal Claude turn.
 */
export interface SlackCommandDeps {
  config: Config;
  bootTime: number;
  io: TurnIO;
  chatId: string;
  userId: string;
  chatKind: "dm" | "group";
  /** Fire a turn (used by /init, /compact). */
  kickOffTurn: (
    io: TurnIO,
    chatId: string,
    userId: number | string,
    prompt: string,
  ) => void;
  abortTurn: (chatId: string, reason?: string) => boolean;
}

export async function dispatchSlackCommand(
  deps: SlackCommandDeps,
  rawText: string,
): Promise<boolean> {
  const text = rawText.trim();
  if (!text.startsWith("/")) return false;
  const tokens = text.slice(1).split(/\s+/);
  const cmd = (tokens[0] ?? "").toLowerCase();
  if (!cmd) return false;
  const args = tokens.slice(1);

  const cd: CommandDeps = {
    config: deps.config,
    bootTime: deps.bootTime,
    io: deps.io,
    chatId: deps.chatId,
    userId: deps.userId,
    chatKind: deps.chatKind,
    kickOff: (prompt) =>
      deps.kickOffTurn(deps.io, deps.chatId, deps.userId, prompt),
    abort: (reason) => deps.abortTurn(deps.chatId, reason),
  };

  const handled = await runCommand(cd, cmd, args);
  if (handled) return true;
  // Recognized prefix but the runner doesn't know it. Tell the user — and
  // still return true so the caller doesn't ALSO send the input to Claude.
  if (isCommandName(cmd)) return true;
  await deps.io.reply(`Unknown command "/${cmd}". Try /help for the list.`);
  return true;
}

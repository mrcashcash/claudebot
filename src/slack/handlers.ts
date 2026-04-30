import type { App } from "@slack/bolt";
import type { Config } from "../config.ts";
import * as users from "../state/users.ts";
import { seedDefaultCronsIfMissing } from "../state/seedDefaultCrons.ts";
import { ioFromSlack } from "./io.ts";
import { dispatchSlackCommand } from "./commands.ts";
import { logError } from "../state/logger.ts";
import type { TurnIO } from "../handlers/turnIO.ts";

export interface SlackEventDeps {
  config: Config;
  bootTime: number;
  /** Bot user id (U…) — used to strip `<@bot>` from app_mention text. */
  botUserId: string;
  /** kickOffTurn from buildBot — fires the turn through the shared core. */
  kickOffTurn: (
    io: TurnIO,
    chatId: string,
    userId: number | string,
    prompt: string,
  ) => void;
  abortTurn: (chatId: string, reason?: string) => boolean;
}

/** Strip the bot's own mention token from the front of a message body. */
function stripBotMention(text: string, botUserId: string): string {
  const re = new RegExp(`^\\s*<@${botUserId}>\\s*`);
  return text.replace(re, "").trim();
}

/**
 * Authorize a Slack user against the env allowlist and seed a default config
 * block on their first message. Returns true if the user can talk to the bot.
 */
async function authorize(
  config: Config,
  userId: string | undefined,
): Promise<boolean> {
  if (!config.slack || !userId) return false;
  if (!config.slack.allowedUserIds.has(userId)) {
    console.warn(`[slack] auth rejected user_id=${userId}`);
    return false;
  }
  await users.ensure(userId).catch((err) => {
    void logError("error.users_ensure", err, { userId });
  });
  return true;
}

export function registerSlackEvents(app: App, deps: SlackEventDeps): void {
  const { config, bootTime, botUserId, kickOffTurn, abortTurn } = deps;

  // DM messages (Slack: channel_type === "im"). We skip subtype'd events
  // (edits / deletes / bot replies) and our own bot's messages.
  app.event("message", async ({ event, client }) => {
    const e = event as {
      channel?: string;
      channel_type?: string;
      user?: string;
      text?: string;
      ts?: string;
      subtype?: string;
      bot_id?: string;
    };
    if (e.channel_type !== "im") return;
    if (e.subtype) return;
    if (e.bot_id) return;
    const userId = e.user;
    const channelId = e.channel;
    const text = e.text ?? "";
    if (!userId || !channelId) return;
    if (!(await authorize(config, userId))) return;
    await seedDefaultCronsIfMissing(channelId, userId, "slack").catch((err) => {
      void logError("error.seed_default_crons", err, { userId });
    });

    const io = ioFromSlack(client, channelId, "dm");
    if (text.startsWith("/")) {
      const handled = await dispatchSlackCommand(
        {
          config,
          bootTime,
          io,
          chatId: channelId,
          userId,
          chatKind: "dm",
          kickOffTurn,
          abortTurn,
        },
        text,
      );
      if (handled) return;
    }
    if (text.trim().length === 0) return;
    kickOffTurn(io, channelId, userId, text);
  });

  // Channel mentions: bot is invited to a channel and someone @-mentions it.
  // We treat these as "group" turns. The mention prefix is stripped so Claude
  // sees the user's actual question.
  app.event("app_mention", async ({ event, client }) => {
    const e = event as {
      channel?: string;
      user?: string;
      text?: string;
      ts?: string;
      thread_ts?: string;
    };
    const userId = e.user;
    const channelId = e.channel;
    if (!userId || !channelId) return;
    if (!(await authorize(config, userId))) return;
    const stripped = stripBotMention(e.text ?? "", botUserId);

    // If the mention was inside a thread, stay in that thread. Otherwise
    // anchor a new thread to the mention's own ts so back-and-forth replies
    // don't fan out across the channel.
    const threadTs = e.thread_ts ?? e.ts;
    const io = ioFromSlack(client, channelId, "group", threadTs);
    if (stripped.startsWith("/")) {
      const handled = await dispatchSlackCommand(
        {
          config,
          bootTime,
          io,
          chatId: channelId,
          userId,
          chatKind: "group",
          kickOffTurn,
          abortTurn,
        },
        stripped,
      );
      if (handled) return;
    }
    if (stripped.length === 0) {
      await io.reply("Mention me with a question — e.g. `@claude what files are in this workspace?`");
      return;
    }
    kickOffTurn(io, channelId, userId, stripped);
  });
}

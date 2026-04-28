import { App, LogLevel } from "@slack/bolt";
import type { Config, SlackConfig } from "../config.ts";
import type { TurnEngine } from "../core/turnEngine.ts";
import { registerSlackActions } from "./actions.ts";
import { registerSlackEvents } from "./handlers.ts";
import { ioFromSlack } from "./io.ts";
import { registerTransport } from "../scheduler/transport.ts";
import type { ChatKind } from "../handlers/turnIO.ts";
import { logError } from "../state/logger.ts";

export interface SlackApp {
  /** Begin the Socket Mode connection. */
  start(): Promise<void>;
  /** Tear down the Socket Mode connection. */
  stop(): Promise<void>;
  /** Bot user id (U…). */
  botUserId: string;
  /** Send a one-off notice to a Slack channel/DM (used during graceful reload). */
  notifyChat(chatId: string, text: string): Promise<void>;
}

/**
 * Build (but don't yet start) the Slack Bolt app on top of the shared turn
 * engine. Caller invokes `.start()` after wiring up other lifecycle pieces.
 *
 * Registers the "slack" transport with the scheduler so a cron created from
 * a Slack channel fires back into Slack at the scheduled minute.
 */
export async function buildSlackApp(
  slack: SlackConfig,
  config: Config,
  engine: TurnEngine,
  bootTime: number,
): Promise<SlackApp> {
  const app = new App({
    token: slack.botToken,
    appToken: slack.appToken,
    socketMode: true,
    logLevel: LogLevel.WARN,
  });

  // Resolve our own user id once (used to strip mentions from app_mention).
  const auth = await app.client.auth.test({ token: slack.botToken });
  const botUserId = (auth.user_id as string | undefined) ?? "";
  if (!botUserId) {
    throw new Error("Slack auth.test did not return user_id");
  }
  console.log(`[slack] boot user_id=${botUserId} team=${auth.team_id ?? "?"}`);

  // Register the transport so a cron created from a Slack chat dispatches
  // back to Slack at fire time. Derive chatKind from the channel id prefix:
  // D… = DM, C…/G… = channel/MPIM/private channel.
  registerTransport("slack", (chatId, userId, prompt, opts) => {
    const chatKind: ChatKind = chatId.startsWith("D") ? "dm" : "group";
    const io = ioFromSlack(app.client, chatId, chatKind);
    engine.kickOffTurn(io, chatId, userId, prompt, opts);
  });

  registerSlackEvents(app, {
    config,
    bootTime,
    botUserId,
    kickOffTurn: engine.kickOffTurn,
    abortTurn: engine.abortTurn,
  });
  registerSlackActions(app);

  app.error(async (err) => {
    void logError("error.slack", err);
    console.error("[slack] handler error:", err);
  });

  return {
    botUserId,
    async start() {
      await app.start();
      console.log("[slack] socket mode connected");
    },
    async stop() {
      try {
        await app.stop();
      } catch (err) {
        void logError("error.slack_stop", err);
      }
    },
    async notifyChat(chatId: string, text: string) {
      try {
        await app.client.chat.postMessage({ channel: chatId, text });
      } catch {
        // ignore — channel may have been left or archived
      }
    },
  };
}

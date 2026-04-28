import "dotenv/config";
import { loadConfig } from "./config.ts";
import { buildTurnEngine } from "./core/turnEngine.ts";
import { buildTelegramApp } from "./telegram/app.ts";
import { buildSlackApp, type SlackApp } from "./slack/app.ts";
import * as store from "./state/store.ts";
import * as sessions from "./state/sessions.ts";
import * as users from "./state/users.ts";
import * as crons from "./state/crons.ts";
import * as restartMarker from "./state/restart-marker.ts";
import type { RestartChat, Transport } from "./state/restart-marker.ts";
import * as busy from "./lifecycle/busy.ts";
import * as keepalive from "./lifecycle/keepalive.ts";
import * as cronTicker from "./scheduler/ticker.ts";
import { registerTransport } from "./scheduler/transport.ts";
import { log, logError, sweepOldLogs } from "./state/logger.ts";

process.on("unhandledRejection", (err) => {
  void logError("error.uncaught_rejection", err);
  console.error("[unhandledRejection]", err);
});
process.on("uncaughtException", (err) => {
  void logError("error.uncaught_exception", err);
  console.error("[uncaughtException]", err);
});

/** Tag a chat id by its likely transport. Telegram chat ids parse as
 *  finite numbers; Slack channel/DM ids are strings (C…/D…/G…). */
function transportOf(chatId: string): Transport {
  return Number.isFinite(Number(chatId)) ? "telegram" : "slack";
}

const SHUTDOWN_DRAIN_MS = 30 * 60 * 1000; // 30 minutes max

async function main(): Promise<void> {
  const config = loadConfig();
  await store.load();
  await sessions.load();
  await users.load();
  users.watch();
  await crons.load();
  await sweepOldLogs(30);
  await busy.reset();
  keepalive.start();

  const userIds = users.allUserIds();
  const bootTime = Date.now();
  console.log(`gateway dir: ${config.gatewayDir}`);
  console.log(`allowlist (env): ${[...config.allowedUserIds].join(", ")}`);
  console.log(
    `users with config: ${userIds.length}${userIds.length > 0 ? ` (${userIds.join(", ")})` : ""}`,
  );
  if (config.slack) {
    console.log(
      `slack enabled — allowlist: ${[...config.slack.allowedUserIds].join(", ")}`,
    );
  } else {
    console.log(
      "slack disabled (no SLACK_BOT_TOKEN / SLACK_APP_TOKEN / ALLOWED_SLACK_USER_IDS)",
    );
  }
  console.log(`code loaded at ${new Date().toISOString()}`);

  const engine = buildTurnEngine(config);
  const tg = buildTelegramApp(config, engine, bootTime);

  // Register the Telegram transport with the scheduler — cron fires created
  // from a Telegram chat dispatch through this entry. The Slack transport
  // registers itself inside buildSlackApp.
  registerTransport("telegram", tg.kickOffTurnFromCron);

  await tg.setMyCommands();

  let slack: SlackApp | undefined;
  if (config.slack) {
    try {
      slack = await buildSlackApp(config.slack, config, engine, bootTime);
    } catch (err) {
      void logError("error.slack_boot", err);
      console.error("[slack] boot failed — running Telegram-only:", err);
    }
  }

  // Surface orphaned crons: if any rows in data/crons.json target a transport
  // that didn't come up this boot, fires will be silently dropped every minute.
  // Warn once at boot so the user can disable them or fix their config.
  if (!slack) {
    const orphanSlackCrons = crons
      .allEnabled()
      .filter((c) => c.transport === "slack");
    if (orphanSlackCrons.length > 0) {
      const ids = orphanSlackCrons.map((c) => c.id).join(", ");
      console.warn(
        `[cron] WARNING: ${orphanSlackCrons.length} enabled Slack cron(s) but Slack is not running — fires will be dropped. Cron ids: ${ids}`,
      );
      void log({
        category: "lifecycle",
        event: "lifecycle.cron_orphans",
        transport: "slack",
        cronIds: orphanSlackCrons.map((c) => c.id),
      });
    }
  }

  const marker = await restartMarker.consume().catch(() => null);
  if (marker && marker.chats.length > 0) {
    const elapsedMs = Date.now() - marker.shutdownAt;
    const elapsed = elapsedMs >= 0 ? `${(elapsedMs / 1000).toFixed(1)}s` : "?";
    const text = `✅ Bot reloaded (${marker.reason}, downtime ${elapsed}). New code is live.`;
    await Promise.allSettled(
      marker.chats.map(async (entry) => {
        if (entry.transport === "telegram") {
          await tg.notifyChat(entry.chatId, text);
        } else if (entry.transport === "slack" && slack) {
          await slack.notifyChat(entry.chatId, text);
        }
      }),
    );
  }

  let shuttingDown = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    const shutdownStart = Date.now();

    // Stop the scheduler first so no new cron fires during the drain window.
    cronTicker.stop();
    users.stopWatch();
    engine.beginShutdown();

    const inFlight = engine.inFlightChats();
    const last = engine.lastActiveChat();
    const chatSet = new Set<string>(inFlight);
    if (last) chatSet.add(last);
    const chats: RestartChat[] = [...chatSet].map((id) => ({
      chatId: id,
      transport: transportOf(id),
    }));

    void log({
      category: "lifecycle",
      event: "lifecycle.shutdown.start",
      reason: sig,
      affectedChats: chats,
      inFlightCount: inFlight.length,
    });
    await restartMarker
      .write({
        chats,
        reason: sig,
        shutdownAt: Date.now(),
      })
      .catch((err) => {
        void logError("error.restart_marker_write", err);
        console.error("[shutdown] restart-marker write failed:", err);
      });

    const inFlightAtStart = [...inFlight];
    if (inFlightAtStart.length > 0) {
      console.log(
        `[shutdown] ${sig} — waiting up to ${SHUTDOWN_DRAIN_MS / 60000}min for ${inFlightAtStart.length} in-flight turn(s) to finish`,
      );
      await Promise.allSettled(
        inFlightAtStart.map(async (id) => {
          const text =
            "🔄 Code change detected — bot will reload after this turn finishes. Sit tight.";
          if (transportOf(id) === "telegram") return tg.notifyChat(id, text);
          if (slack) return slack.notifyChat(id, text);
          return undefined;
        }),
      );

      // Race the per-chat tail Promises against the drain deadline.
      const tailsSnapshot = engine.turnTails();
      let timeoutHandle: NodeJS.Timeout | undefined;
      await new Promise<void>((resolve) => {
        timeoutHandle = setTimeout(resolve, SHUTDOWN_DRAIN_MS);
        void Promise.allSettled(tailsSnapshot).then(() => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          resolve();
        });
      });

      const stillInFlight = engine.inFlightChats();
      if (stillInFlight.length > 0) {
        void log({
          category: "lifecycle",
          event: "lifecycle.shutdown.drain_timeout",
          pendingChats: stillInFlight,
          waitedMs: SHUTDOWN_DRAIN_MS,
        });
        console.warn(
          `[shutdown] ${stillInFlight.length} turn(s) still running after ${SHUTDOWN_DRAIN_MS / 60000}min; aborting`,
        );
        engine.abortAll("shutdown");
        await Promise.allSettled(
          stillInFlight.map(async (id) => {
            const text =
              "⚠️ Bot has been waiting too long for your turn to finish — forcing reload now. Your in-flight request was cut short.";
            if (transportOf(id) === "telegram") return tg.notifyChat(id, text);
            if (slack) return slack.notifyChat(id, text);
            return undefined;
          }),
        );
      } else {
        console.log(`[shutdown] all turns drained, restarting`);
      }
    } else {
      console.log(`[shutdown] ${sig} — no in-flight turns, restarting`);
    }

    const forcedAbort = engine.inFlightChats().length > 0;

    if (slack) {
      await slack.stop();
    }
    await tg.stop(sig);
    await engine.finalize();

    void log({
      category: "lifecycle",
      event: "lifecycle.shutdown.complete",
      reason: sig,
      durationMs: Date.now() - shutdownStart,
      forcedAbort,
    });

    keepalive.stop();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  cronTicker.start();
  await tg.start();
  if (slack) {
    await slack.start();
  }
  await log({
    category: "lifecycle",
    event: "lifecycle.boot",
    userCount: userIds.length,
    cronsLoaded: crons.allEnabled().length,
    restartChats: marker?.chats ?? [],
    botUsername: tg.username(),
    slackEnabled: !!slack,
  });
}

main().catch((err) => {
  void logError("error.fatal_main", err);
  console.error("fatal:", err);
  process.exit(1);
});

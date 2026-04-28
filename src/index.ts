import "dotenv/config";
import { loadConfig } from "./config.ts";
import { buildBot, COMMAND_MENU } from "./bot.ts";
import * as store from "./state/store.ts";
import * as sessions from "./state/sessions.ts";
import * as users from "./state/users.ts";
import * as crons from "./state/crons.ts";
import * as restartMarker from "./state/restart-marker.ts";
import * as busy from "./lifecycle/busy.ts";
import * as keepalive from "./lifecycle/keepalive.ts";
import * as cronTicker from "./scheduler/ticker.ts";
import { log, logError, sweepOldLogs } from "./state/logger.ts";

process.on("unhandledRejection", (err) => {
  void logError("error.uncaught_rejection", err);
  console.error("[unhandledRejection]", err);
});
process.on("uncaughtException", (err) => {
  void logError("error.uncaught_exception", err);
  console.error("[uncaughtException]", err);
});

async function main(): Promise<void> {
  const config = loadConfig();
  await store.load();
  await sessions.load();
  await users.load();
  users.watch();
  await crons.load();
  await sweepOldLogs(30);
  // Clear any stale .busy left over from a hard crash so the dev runner
  // doesn't get stuck waiting on a sentinel that no live process owns.
  await busy.reset();
  keepalive.start();

  const userIds = users.allUserIds();
  console.log(`gateway dir: ${config.gatewayDir}`);
  console.log(`allowlist (env): ${[...config.allowedUserIds].join(", ")}`);
  console.log(
    `users with config: ${userIds.length}${userIds.length > 0 ? ` (${userIds.join(", ")})` : ""}`,
  );
  console.log(`code loaded at ${new Date().toISOString()}`);

  const { bot, kickOffTurnFromCron, gracefulShutdown } = buildBot(config);

  const me = await bot.telegram.getMe();
  console.log(`bot started as @${me.username}`);

  await bot.telegram
    .setMyCommands(COMMAND_MENU.map((c) => ({ ...c })))
    .catch((err) => console.warn("[boot] setMyCommands failed:", err));

  const marker = await restartMarker.consume().catch(() => null);
  if (marker && marker.chats.length > 0) {
    const elapsedMs = Date.now() - marker.shutdownAt;
    const elapsed = elapsedMs >= 0 ? `${(elapsedMs / 1000).toFixed(1)}s` : "?";
    const text = `✅ Bot reloaded (${marker.reason}, downtime ${elapsed}). New code is live.`;
    await Promise.allSettled(
      marker.chats.map((id) => bot.telegram.sendMessage(id, text)),
    );
  }

  let shuttingDown = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Stop the scheduler first so no new cron fires during the drain window.
    cronTicker.stop();
    users.stopWatch();
    try {
      await gracefulShutdown(sig);
    } catch (err) {
      void logError("error.shutdown", err, { signal: sig });
      console.error("[shutdown] error during graceful shutdown:", err);
    } finally {
      keepalive.stop();
      process.exit(0);
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  cronTicker.start({ kickOffTurnFromCron });
  await bot.launch({ dropPendingUpdates: true });
  await log({
    category: "lifecycle",
    event: "lifecycle.boot",
    userCount: userIds.length,
    cronsLoaded: crons.allEnabled().length,
    restartChats: marker?.chats ?? [],
    botUsername: me.username,
  });
}

main().catch((err) => {
  void logError("error.fatal_main", err);
  console.error("fatal:", err);
  process.exit(1);
});

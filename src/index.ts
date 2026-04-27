import "dotenv/config";
import fs from "node:fs/promises";
import { loadConfig } from "./config.ts";
import { buildBot, COMMAND_MENU } from "./bot.ts";
import * as sessions from "./state/sessions.ts";
import * as restartMarker from "./state/restart-marker.ts";
import * as busy from "./lifecycle/busy.ts";
import * as keepalive from "./lifecycle/keepalive.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  await fs.mkdir(config.workspaceDir, { recursive: true });
  await sessions.load();
  // Clear any stale .busy left over from a hard crash so the dev runner
  // doesn't get stuck waiting on a sentinel that no live process owns.
  await busy.reset();
  keepalive.start();

  const authLine =
    config.authMode === "oauth-token"
      ? "auth: long-lived OAuth token (CLAUDE_CODE_OAUTH_TOKEN)"
      : "auth: subscription login from ~/.claude/.credentials.json (run `claude` once to verify)";
  console.log(authLine);
  console.log(`workspace: ${config.workspaceDir}`);
  console.log(`permission mode: ${config.permissionMode}`);
  console.log(`allowlist: ${[...config.allowedUserIds].join(", ")}`);
  console.log(`code loaded at ${new Date().toISOString()}`);

  if (config.workspaceDir === process.cwd()) {
    console.warn(
      "[warn] workspace == gateway dir — Claude can edit this bot's source. " +
        "Run with `npm run dev` for auto-reload on save.",
    );
  }

  const { bot, gracefulShutdown } = buildBot(config);

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
    try {
      await gracefulShutdown(sig);
    } catch (err) {
      console.error("[shutdown] error during graceful shutdown:", err);
    } finally {
      keepalive.stop();
      process.exit(0);
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await bot.launch({ dropPendingUpdates: true });
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});

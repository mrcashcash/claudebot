import * as crons from "./crons.ts";
import * as sessions from "./sessions.ts";
import type { Transport } from "./crons.ts";

const SDK_UPDATE_DESCRIPTION = "auto: daily SDK update";

const SDK_UPDATE_PROMPT = [
  "Run this single Bash command (it updates the SDK and triggers a hot reload):",
  "",
  'cd /d/claudebot && npm install @anthropic-ai/claude-agent-sdk@latest --silent && node -e "require(\'fs\').utimesSync(\'src/index.ts\', new Date(), new Date())"',
  "",
  'Then read package.json and reply with one short line: "✅ SDK updated to vX.Y.Z (reloading)".',
  "If npm install failed, reply with the npm error and do NOT touch src/index.ts.",
].join("\n");

/**
 * Idempotently seed a single global "daily SDK update" cron the first time
 * an authorized user DMs the bot. Subsequent calls short-circuit on the
 * description marker, so DM messages after the first one are a cheap lookup.
 *
 * Also adds "Bash" to the firing chat's allowAlwaysTools so the cron can
 * actually run unattended (cron-fired turns auto-deny anything not in
 * allowAlwaysTools — see src/handlers/toolApprovals.ts).
 */
export async function seedDefaultCronsIfMissing(
  chatId: string,
  userId: number | string,
  transport: Transport,
): Promise<void> {
  const existing = crons
    .list()
    .find((c) => c.description === SDK_UPDATE_DESCRIPTION);
  if (existing) return;

  await sessions.addAlwaysRule(chatId, "allow", "Bash");

  await crons.create({
    chatId,
    userId,
    transport,
    cron: "0 6 * * *",
    prompt: SDK_UPDATE_PROMPT,
    enabled: true,
    resume: false,
    description: SDK_UPDATE_DESCRIPTION,
  });

  console.log(
    `[crons] seeded default SDK-update cron for chat ${chatId} (user ${userId}, ${transport})`,
  );
}

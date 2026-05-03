import * as crons from "./crons.ts";
import type { Transport } from "./crons.ts";

const SDK_UPDATE_DESCRIPTION = "auto: daily SDK update";
const SDK_UPDATE_TASK = "sdk-update";

/**
 * Idempotently seed a single global "daily SDK update" cron the first time
 * an authorized user DMs the bot. Subsequent calls short-circuit on the
 * description marker, so DM messages after the first one are a cheap lookup.
 *
 * The cron uses the `systemTask` path — at fire time the scheduler runs the
 * `sdk-update` handler directly (npm install, fetch release notes, touch
 * `src/index.ts` to trigger tsx-watch reload) and posts the result via
 * notifyChat. No Claude turn, no Bash allow-always permission needed.
 *
 * Migrates legacy seeded rows (those with the old prompt-based form) by
 * upgrading them in place — keeps cron id and timing, drops the prompt.
 */
export async function seedDefaultCronsIfMissing(
  chatId: string,
  userId: number | string,
  transport: Transport,
): Promise<void> {
  const existing = crons
    .list()
    .find((c) => c.description === SDK_UPDATE_DESCRIPTION);

  if (existing) {
    if (existing.systemTask !== SDK_UPDATE_TASK) {
      // Legacy prompt-based seed — upgrade in place.
      await crons.update(existing.id, {
        systemTask: SDK_UPDATE_TASK,
        prompt: "",
      });
      console.log(
        `[crons] upgraded legacy SDK-update cron ${existing.id} to systemTask form`,
      );
    }
    return;
  }

  await crons.create({
    chatId,
    userId,
    transport,
    cron: "0 6 * * *",
    prompt: "",
    enabled: true,
    resume: false,
    description: SDK_UPDATE_DESCRIPTION,
    systemTask: SDK_UPDATE_TASK,
  });

  console.log(
    `[crons] seeded default SDK-update cron for chat ${chatId} (user ${userId}, ${transport}) as systemTask`,
  );
}

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { CronExpressionParser } from "cron-parser";
import * as crons from "../state/crons.ts";

export const MAX_CRONS_PER_CHAT = 20;

/**
 * Build the per-turn scheduler system prompt addendum. The TZ varies per user
 * (each user's app config can override it), so the guidance is composed when
 * the turn starts rather than baked into a module-level constant.
 *
 * Also tells Claude where its own per-user app config lives so it can edit it
 * when asked ("change my model to opus", "switch workspace to X"). The file
 * is auto-reloaded by the bot — the next turn picks up edits.
 */
export function buildSchedulerSystemGuidance(
  tz: string,
  userId: number,
  chatId: number | string,
): string {
  const isGroup = String(chatId) !== String(userId);
  const scopeAdvice = isGroup
    ? `This conversation is a Telegram group (chatId=${chatId}, userId=${userId}). \`workspaceDir\`, \`permissionMode\`, and \`model\` can be overridden per-chat — set in this group only — and that's almost always what the user wants when they say "switch my workspace" inside a group, since changing the user file would also change every other group/DM. Recommend the slash commands \`/workspace <path>\`, \`/mode <mode>\`, \`/model <alias>\` — they auto-write to the chat layer in groups. Don't edit \`data/sessions.json\` directly from inside a turn; that file is not watched, so your edit won't take effect until the next bot restart.`
    : `This conversation is a Telegram DM (chatId === userId). Editing \`data/users/${userId}.json\` is the right move for "switch my workspace / model / mode" requests here.`;
  return `When the user asks to be reminded about something at a future date/time, schedule it via the \`mcp__scheduler__cron_create\` tool (cron expression evaluated in ${tz}; pass \`oneShot: true\` for one-time reminders so the row auto-deletes after firing).

Additionally, **if and only if** a Google Calendar MCP tool is available in this turn (look for tools whose name matches \`mcp__*calendar*__create_event\` or similar), AND the reminder is for a real-world calendar event — meeting, appointment, doctor visit, flight, dentist, interview, birthday, anniversary, deadline, class, hangout — also create a calendar event for it. Use the same date/time/timezone, put the user's phrasing as the event title, and put any context as the description.

Do NOT create a calendar event for data-pull or recurring-task crons — weather updates, news/stock summaries, periodic reports, "every morning fetch X", server health checks, etc. Those are cron-only.

If no calendar tool is available this turn, just create the cron and don't mention calendar; the user already knows whether they wired one up.

Your per-user app config lives at \`data/users/${userId}.json\`. Editable keys: \`workspaceDir\`, \`permissionMode\` (default/acceptEdits/bypassPermissions/plan), \`model\` (claude-opus-4-7/claude-sonnet-4-6/claude-haiku-4-5-20251001 or "" for SDK default), \`tz\` (IANA), \`voice\` (object with enabled/whisperModel/language/preloadModel/maxDurationSec), \`name\`, \`notes\`. The bot watches this file; edits are picked up on the next turn. Do not modify \`.env\` or other config files.

${scopeAdvice}`;
}

// The SDK's CallToolResult type has an index signature ([x: string]: unknown),
// so a plain object literal works fine — we just don't bother declaring our
// own intermediate interface.
const ok = (text: string) => ({
  content: [{ type: "text" as const, text }],
});
const err = (text: string) => ({
  content: [{ type: "text" as const, text }],
  isError: true,
});

function validateCron(
  expr: string,
  tz: string,
): { ok: true } | { ok: false; reason: string } {
  try {
    CronExpressionParser.parse(expr, { tz });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

function describeCron(c: crons.Cron, tz: string): string {
  let nextStr = "n/a";
  try {
    const it = CronExpressionParser.parse(c.cron, { tz });
    nextStr = it.next().toDate().toISOString();
  } catch {
    nextStr = "(invalid expression)";
  }
  const last =
    c.lastFiredAt !== undefined
      ? new Date(c.lastFiredAt).toISOString()
      : "never";
  return [
    `id=${c.id}`,
    `cron="${c.cron}" (${tz})`,
    `next=${nextStr}`,
    `lastFired=${last}`,
    `enabled=${c.enabled}`,
    `resume=${c.resume}`,
    c.oneShot ? `oneShot=true` : null,
    c.description ? `desc="${c.description}"` : null,
    `prompt=${JSON.stringify(c.prompt.length > 200 ? c.prompt.slice(0, 200) + "…" : c.prompt)}`,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Builds a per-chat scheduler MCP server. chatId AND userId are captured by
 * closure: chatId so Claude cannot read or mutate another chat's jobs (list
 * filters by chatId, delete verifies the id belongs to the chat); userId so
 * the row records who owns the cron, which drives per-user config lookups
 * (TZ, workspace, mode) when the cron later fires.
 */
export function buildSchedulerMcp(chatId: number, userId: number, tz: string) {
  return createSdkMcpServer({
    name: "scheduler",
    version: "1.0.0",
    tools: [
      tool(
        "cron_create",
        `Schedule a prompt for THIS chat. The cron expression is a 5-field crontab (minute hour dom month dow), evaluated in ${tz}. When it fires, the prompt runs as a fresh Claude turn and the result is posted back to this chat. Persistent across bot restarts. Limit: ${MAX_CRONS_PER_CHAT} crons per chat. Tool calls inside the fired prompt are auto-denied unless they are in the chat's always-allow list (use /rules interactively to pre-approve), so include only operations the user has already approved. For one-time reminders ("remind me Sunday at 10"), set oneShot=true so the job auto-deletes after firing instead of recurring forever.`,
        {
          cron: z
            .string()
            .describe(
              "5-field cron expression, e.g. '0 8 * * *' for 08:00 daily, '*/5 * * * *' for every 5 minutes. For a one-time fire pick a date-specific expression like '0 10 3 5 *' (May 3 at 10:00) and pair it with oneShot=true.",
            ),
          prompt: z
            .string()
            .min(1)
            .describe("The prompt Claude will run when the cron fires"),
          resume: z
            .boolean()
            .optional()
            .describe(
              "If true, the fire continues this chat's current Claude session. If false (default), each fire is a fresh session — recommended for periodic reports so they don't carry conversational baggage.",
            ),
          oneShot: z
            .boolean()
            .optional()
            .describe(
              "If true, the cron is auto-deleted after its first fire. Use this for one-time reminders so they don't recur on the same cron slot every week/year. Default false.",
            ),
          description: z
            .string()
            .optional()
            .describe("Optional human-readable label for /cron list"),
        },
        async ({ cron, prompt, resume, oneShot, description }) => {
          const v = validateCron(cron, tz);
          if (!v.ok) return err(`Invalid cron expression: ${v.reason}`);
          if (crons.countByChat(chatId) >= MAX_CRONS_PER_CHAT) {
            return err(
              `This chat already has ${MAX_CRONS_PER_CHAT} crons (the limit). Delete one with cron_delete before adding another.`,
            );
          }
          const created = await crons.create({
            chatId,
            userId,
            cron,
            prompt,
            enabled: true,
            resume: resume === true,
            ...(oneShot === true ? { oneShot: true } : {}),
            ...(description ? { description } : {}),
          });
          return ok(
            `✅ Created cron ${created.id}\n${describeCron(created, tz)}`,
          );
        },
      ),
      tool(
        "cron_list",
        "List all scheduled crons for THIS chat. Output is a plain-text summary with id, cron expression, next fire time, last fire time, enabled flag, and prompt preview.",
        {},
        async () => {
          const list = crons.list(chatId);
          if (list.length === 0) {
            return ok("(no crons scheduled in this chat)");
          }
          const lines = list
            .sort((a, b) => a.createdAt - b.createdAt)
            .map((c) => describeCron(c, tz));
          return ok(`${list.length} cron(s):\n` + lines.join("\n"));
        },
      ),
      tool(
        "cron_delete",
        "Delete a scheduled cron by id. Only crons belonging to THIS chat can be deleted — cross-chat deletion is rejected.",
        {
          id: z.string().describe("The cron id, as shown by cron_list"),
        },
        async ({ id }) => {
          const existing = crons.get(id);
          if (!existing) return err(`No cron with id ${id}`);
          if (existing.chatId !== chatId) {
            return err(
              `Cron ${id} does not belong to this chat; refusing to delete.`,
            );
          }
          await crons.remove(id);
          return ok(`🗑️ Deleted cron ${id}`);
        },
      ),
    ],
  });
}

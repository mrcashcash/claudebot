import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { CronExpressionParser } from "cron-parser";
import * as crons from "../state/crons.ts";
import type { Transport } from "../state/crons.ts";
import { log } from "../state/logger.ts";

export const MAX_CRONS_PER_CHAT = 20;

/**
 * Prompt budget for the all-crons listing. Single-cron lookups and the
 * create/update echoes are never truncated — a truncated prompt cannot be
 * edited faithfully.
 */
const PROMPT_PREVIEW_CHARS = 400;

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
  userId: number | string,
  chatId: number | string,
  isGroup: boolean,
): string {
  const scopeAdvice = isGroup
    ? `This conversation is a group/channel (chatId=${chatId}, userId=${userId}). \`workspaceDir\`, \`permissionMode\`, and \`model\` can be overridden per-chat — set in this group only — and that's almost always what the user wants when they say "switch my workspace" inside a group, since changing the user-layer setting would also change every other group/DM. Recommend the slash commands \`/workspace <path>\`, \`/mode <mode>\`, \`/model <alias>\` — they auto-write to the chat layer in groups. The \`sessions\` section of \`data/config.json\` is the live source of truth for chat-layer state, so prefer the slash commands over hand-editing it.`
    : `This conversation is a DM. Editing the \`users.${userId}\` block inside \`data/config.json\` is the right move for "switch my workspace / model / mode" requests here — the bot watches that file and reloads the next turn.`;
  return `When the user asks to be reminded about something at a future date/time, schedule it via the \`mcp__scheduler__cron_create\` tool (cron expression evaluated in ${tz}; pass \`oneShot: true\` for one-time reminders so the row auto-deletes after firing).

Additionally, **if and only if** a Google Calendar MCP tool is available in this turn (look for tools whose name matches \`mcp__*calendar*__create_event\` or similar), AND the reminder is for a real-world calendar event — meeting, appointment, doctor visit, flight, dentist, interview, birthday, anniversary, deadline, class, hangout — also create a calendar event for it. Use the same date/time/timezone, put the user's phrasing as the event title, and put any context as the description.

Do NOT create a calendar event for data-pull or recurring-task crons — weather updates, news/stock summaries, periodic reports, "every morning fetch X", server health checks, etc. Those are cron-only.

If no calendar tool is available this turn, just create the cron and don't mention calendar; the user already knows whether they wired one up.

Your per-user app config lives in \`data/config.json\` under the \`users.${userId}\` key. Editable fields: \`workspaceDir\`, \`permissionMode\` (default/acceptEdits/bypassPermissions/plan), \`model\` (claude-opus-4-7/claude-sonnet-4-6/claude-haiku-4-5-20251001 or "" for SDK default), \`tz\` (IANA), \`voice\` (object with enabled/whisperModel/language/preloadModel/maxDurationSec), \`name\`, \`notes\`. The bot watches \`data/config.json\`; edits are picked up on the next turn. The same file also holds \`sessions.<chatId>\` (per-chat runtime state and overrides) — leave that alone unless you really mean to. Do not modify \`.env\` or other config files.

${scopeAdvice}`;
}

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

function describeCron(
  c: crons.Cron,
  tz: string,
  opts: { fullPrompt?: boolean } = {},
): string {
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
  const truncated = !opts.fullPrompt && c.prompt.length > PROMPT_PREVIEW_CHARS;
  const promptOut = truncated
    ? c.prompt.slice(0, PROMPT_PREVIEW_CHARS) + "…"
    : c.prompt;
  return [
    `id=${c.id}`,
    `cron="${c.cron}" (${tz})`,
    `next=${nextStr}`,
    `lastFired=${last}`,
    `enabled=${c.enabled}`,
    `resume=${c.resume}`,
    c.oneShot ? `oneShot=true` : null,
    c.systemTask ? `systemTask=${c.systemTask}` : null,
    c.description ? `desc="${c.description}"` : null,
    `prompt=${JSON.stringify(promptOut)}${truncated ? ` (truncated from ${c.prompt.length} chars — call cron_list with id="${c.id}" for the full text)` : ""}`,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Builds a per-chat scheduler MCP server. chatId, userId, and transport are
 * captured by closure so a fired cron is dispatched back to the same chat
 * via the same transport — Claude can never read or mutate another chat's
 * jobs by guessing an id (list filters by chatId, delete verifies the id
 * belongs to the chat).
 */
export function buildSchedulerMcp(
  chatId: string,
  userId: number | string,
  tz: string,
  transport: Transport,
) {
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
            transport,
            cron,
            prompt,
            enabled: true,
            resume: resume === true,
            ...(oneShot === true ? { oneShot: true } : {}),
            ...(description ? { description } : {}),
          });
          void log({
            category: "cron",
            event: "cron.created",
            chatId,
            userId,
            cronId: created.id,
            transport,
            cron,
            prompt,
            resume: resume === true,
            oneShot: oneShot === true,
            description,
          });
          return ok(
            `✅ Created cron ${created.id}\n${describeCron(created, tz, { fullPrompt: true })}`,
          );
        },
      ),
      tool(
        "cron_list",
        `List the scheduled crons for THIS chat: id, cron expression, next fire time, last fire time, enabled flag, and prompt. Prompts longer than ${PROMPT_PREVIEW_CHARS} characters are truncated in the all-crons listing — pass \`id\` to get one cron with its prompt in full, which you must do before rewriting a prompt via cron_update so you are editing the real text and not a preview.`,
        {
          id: z
            .string()
            .optional()
            .describe(
              "Show only this cron, with its full untruncated prompt. Omit to list every cron in the chat.",
            ),
        },
        async ({ id }) => {
          if (id !== undefined) {
            const one = crons.get(id);
            if (!one || one.chatId !== chatId) {
              return err(`No cron with id ${id} in this chat`);
            }
            return ok(describeCron(one, tz, { fullPrompt: true }));
          }
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
        "cron_update",
        `Edit an existing cron of THIS chat in place — its schedule, prompt, resume flag, oneShot flag, description, or enabled/paused state. Pass only the fields you want to change; the rest are left alone and the cron keeps its id. Prefer this over cron_delete + cron_create: recreating mints a new id the user no longer recognises and forces you to restate the whole prompt from a truncated listing. When rewriting a prompt, read it first with cron_list \`id\`. Changing the schedule re-baselines the job to now, so a slot that already passed is not fired retroactively.`,
        {
          id: z.string().describe("The cron id, as shown by cron_list"),
          cron: z
            .string()
            .optional()
            .describe(
              "New 5-field cron expression, e.g. '*/5 * * * *' for every 5 minutes. Omit to keep the current schedule.",
            ),
          prompt: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Replacement prompt. This overwrites the old one rather than appending, so pass the complete text. Omit to keep the current prompt.",
            ),
          resume: z
            .boolean()
            .optional()
            .describe(
              "Whether each fire continues this chat's Claude session (true) or starts fresh (false). Omit to keep the current setting.",
            ),
          oneShot: z
            .boolean()
            .optional()
            .describe(
              "Whether the cron auto-deletes after its next fire. Omit to keep the current setting.",
            ),
          description: z
            .string()
            .optional()
            .describe(
              "New human-readable label shown by /cron list. Omit to keep the current one.",
            ),
          enabled: z
            .boolean()
            .optional()
            .describe(
              "false pauses the cron — the row is kept but never fires; true resumes it. Omit to keep the current state.",
            ),
        },
        async ({ id, cron, prompt, resume, oneShot, description, enabled }) => {
          const existing = crons.get(id);
          if (!existing) return err(`No cron with id ${id}`);
          if (existing.chatId !== chatId) {
            return err(
              `Cron ${id} does not belong to this chat; refusing to update.`,
            );
          }
          if (cron !== undefined) {
            const v = validateCron(cron, tz);
            if (!v.ok) return err(`Invalid cron expression: ${v.reason}`);
          }
          // System-task crons run an in-process handler, not a Claude turn, so
          // `prompt`/`resume` are dead fields on them — and `description` is the
          // marker `seedDefaultCronsIfMissing` matches on, so renaming it would
          // make the seeder create a duplicate. Schedule and enabled only.
          if (
            existing.systemTask &&
            (prompt !== undefined ||
              resume !== undefined ||
              oneShot !== undefined ||
              description !== undefined)
          ) {
            return err(
              `Cron ${id} runs the built-in "${existing.systemTask}" system task rather than a prompt. Only \`cron\` and \`enabled\` are editable on it.`,
            );
          }
          const patch: Partial<Omit<crons.Cron, "id" | "createdAt">> = {
            ...(cron !== undefined ? { cron } : {}),
            ...(prompt !== undefined ? { prompt } : {}),
            ...(resume !== undefined ? { resume } : {}),
            ...(oneShot !== undefined ? { oneShot } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(enabled !== undefined ? { enabled } : {}),
          };
          if (Object.keys(patch).length === 0) {
            return err(
              "Nothing to update — pass at least one of cron, prompt, resume, oneShot, description, enabled.",
            );
          }
          if (cron !== undefined) {
            // `createdAt` stays put on an update, so the ticker's "ignore slots
            // older than createdAt" guard no longer shields the *new*
            // expression's most recent past slot: switching a daily job to
            // '*/5 * * * *' at 14:52 would instantly fire the 14:50 slot,
            // prefixed with a bogus "ran 2m late — bot was offline". Pinning
            // lastFiredAt just under the current minute reproduces what
            // cron_create gets — past slots suppressed, current minute still
            // eligible.
            const now = Date.now();
            patch.lastFiredAt = now - (now % 60_000) - 1;
          }
          await crons.update(id, patch);
          // Re-read so the echo reflects the merged row; fall back to the
          // local merge in case the watcher reloaded the file mid-await.
          const updated = crons.get(id) ?? { ...existing, ...patch };
          void log({
            category: "cron",
            event: "cron.updated",
            chatId,
            userId,
            cronId: id,
            transport: existing.transport,
            changed: Object.keys(patch).filter((k) => k !== "lastFiredAt"),
            ...(cron !== undefined ? { cron } : {}),
            ...(prompt !== undefined ? { prompt } : {}),
            ...(resume !== undefined ? { resume } : {}),
            ...(oneShot !== undefined ? { oneShot } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(enabled !== undefined ? { enabled } : {}),
          });
          return ok(
            `✅ Updated cron ${id}\n${describeCron(updated, tz, { fullPrompt: true })}`,
          );
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
          void log({
            category: "cron",
            event: "cron.deleted",
            chatId,
            userId,
            cronId: id,
          });
          return ok(`🗑️ Deleted cron ${id}`);
        },
      ),
    ],
  });
}

import type { Context, Telegraf } from "telegraf";
import { CronExpressionParser } from "cron-parser";
import * as crons from "../state/crons.ts";
import * as users from "../state/users.ts";

function escMd(s: string): string {
  return s.replace(/[*_`\[\]]/g, "\\$&");
}

function nextFire(expr: string, tz: string): string {
  try {
    const it = CronExpressionParser.parse(expr, { tz });
    return it.next().toDate().toISOString();
  } catch {
    return "(invalid)";
  }
}

function previewPrompt(prompt: string, max = 60): string {
  const trimmed = prompt.replace(/\s+/g, " ").trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max - 1) + "…";
}

async function safeReply(ctx: Context, text: string): Promise<void> {
  try {
    await ctx.reply(text, { parse_mode: "Markdown" });
  } catch {
    await ctx.reply(text.replace(/[*_`]/g, ""));
  }
}

async function handleList(ctx: Context, chatId: number): Promise<void> {
  const list = crons.list(chatId).sort((a, b) => a.createdAt - b.createdAt);
  if (list.length === 0) {
    await safeReply(
      ctx,
      "No crons scheduled in this chat.\n" +
        "Ask Claude in chat to schedule one — e.g. _\"every morning at 8 fetch the weather\"_.",
    );
    return;
  }
  const lines = [`*${list.length} cron(s)*:`, ""];
  for (const c of list) {
    const tz = users.tzFor(c.userId);
    const dot = c.enabled ? "🟢" : "⏸";
    const tag = c.oneShot ? " *(one-shot)*" : "";
    const desc = c.description ? ` — ${escMd(c.description)}` : "";
    lines.push(
      `${dot} \`${c.id}\` \`${escMd(c.cron)}\` (${tz})${tag}${desc}\n` +
        `   next: ${nextFire(c.cron, tz)}\n` +
        `   prompt: _${escMd(previewPrompt(c.prompt))}_`,
    );
  }
  lines.push("");
  lines.push("`/cron pause <id>` · `/cron resume <id>` · `/cron delete <id>`");
  await safeReply(ctx, lines.join("\n"));
}

async function handlePause(
  ctx: Context,
  chatId: number,
  id: string,
): Promise<void> {
  const c = crons.get(id);
  if (!c || c.chatId !== chatId) {
    await ctx.reply(`No cron \`${id}\` in this chat.`, { parse_mode: "Markdown" });
    return;
  }
  if (!c.enabled) {
    await ctx.reply(`Cron \`${id}\` is already paused.`, {
      parse_mode: "Markdown",
    });
    return;
  }
  await crons.update(id, { enabled: false });
  await ctx.reply(`⏸ Paused cron \`${id}\`.`, { parse_mode: "Markdown" });
}

async function handleResume(
  ctx: Context,
  chatId: number,
  id: string,
): Promise<void> {
  const c = crons.get(id);
  if (!c || c.chatId !== chatId) {
    await ctx.reply(`No cron \`${id}\` in this chat.`, { parse_mode: "Markdown" });
    return;
  }
  if (c.enabled) {
    await ctx.reply(`Cron \`${id}\` is already enabled.`, {
      parse_mode: "Markdown",
    });
    return;
  }
  await crons.update(id, { enabled: true });
  await ctx.reply(`▶ Resumed cron \`${id}\`.`, { parse_mode: "Markdown" });
}

async function handleDelete(
  ctx: Context,
  chatId: number,
  id: string,
): Promise<void> {
  const c = crons.get(id);
  if (!c || c.chatId !== chatId) {
    await ctx.reply(`No cron \`${id}\` in this chat.`, { parse_mode: "Markdown" });
    return;
  }
  await crons.remove(id);
  await ctx.reply(`🗑️ Deleted cron \`${id}\`.`, { parse_mode: "Markdown" });
}

export function registerCronCommands(bot: Telegraf): void {
  bot.command("cron", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const args = ctx.message.text.split(/\s+/).slice(1);
    const sub = (args[0] ?? "list").toLowerCase();

    if (sub === "list" || sub === "ls" || sub === "") {
      await handleList(ctx, chatId);
      return;
    }
    const id = args[1];
    if (!id) {
      await ctx.reply(
        "Usage:\n" +
          "  /cron list\n" +
          "  /cron pause <id>\n" +
          "  /cron resume <id>\n" +
          "  /cron delete <id>",
      );
      return;
    }
    if (sub === "pause") return handlePause(ctx, chatId, id);
    if (sub === "resume") return handleResume(ctx, chatId, id);
    if (sub === "delete" || sub === "rm") return handleDelete(ctx, chatId, id);
    await ctx.reply(
      `Unknown subcommand "${sub}". Use list / pause / resume / delete.`,
    );
  });
}

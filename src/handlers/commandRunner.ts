import fs from "node:fs/promises";
import path from "node:path";
import { CronExpressionParser } from "cron-parser";
import type {
  Config,
  PermissionMode,
  VoiceReplyMode,
} from "../config.ts";
import {
  VALID_PERMISSION_MODES,
  VALID_VOICE_REPLY_MODES,
} from "../config.ts";
import * as sessions from "../state/sessions.ts";
import * as users from "../state/users.ts";
import * as crons from "../state/crons.ts";
import {
  findSessionByPrefix,
  listSessions,
  projectsDirFor,
} from "../services/claudeSessions.ts";
import { BOOKMARK_NAME_RE } from "../configValidate.ts";
import * as budget from "../core/budget.ts";
import * as taskRunner from "../core/taskRunner.ts";
import * as tasks from "../state/tasks.ts";
import * as watchers from "../state/watchers.ts";
import * as watcherSources from "../watchers/sources.ts";
import * as watcherTicker from "../watchers/ticker.ts";
import * as trust from "./trustPolicy.ts";
import {
  COMMAND_MENU,
  MODE_ALIASES,
  MODEL_ALIASES,
  scopeNote,
  writeOverride,
  type ChatKind,
} from "./commandShared.ts";
import { VALID_RESPOND_MODES, type RespondMode } from "./respondModes.ts";
import type { TurnIO } from "./turnIO.ts";

/**
 * Per-turn state passed into every command handler. Both Telegram and Slack
 * build this struct and call `runCommand` so command behavior stays in
 * lockstep across transports.
 */
export interface CommandDeps {
  config: Config;
  bootTime: number;
  io: TurnIO;
  chatId: string;
  userId: number | string;
  chatKind: ChatKind;
  /** Fire a turn with the given prompt — used by /init and /compact. */
  kickOff: (prompt: string) => void;
  /** Abort the in-flight turn. Returns true if there was something to abort. */
  abort: (reason?: string) => boolean;
}

const COMMAND_NAMES: Set<string> = new Set(COMMAND_MENU.map((c) => c.command));

export function isCommandName(name: string): boolean {
  return COMMAND_NAMES.has(name);
}

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

async function reply(deps: CommandDeps, text: string, markdown = true): Promise<void> {
  await deps.io.reply(text, markdown ? { parseMode: "markdown" } : undefined);
}

function helpText(transport: "telegram" | "slack"): string {
  const intro =
    transport === "telegram"
      ? "*Telegram → Claude Code gateway*\n" +
        "Send any text and Claude works in your configured workspace " +
        "(set in `data/config.json` under `users.<your-id>`, default is the gateway dir).\n" +
        "You can also send *photos* (Claude sees them), *documents* (saved to `.uploads/` for Claude to read), " +
        "and *voice messages* (transcribed locally with Whisper, no cloud).\n" +
        "When Claude wants to run a tool you'll see Allow / Always / Deny / Never buttons.\n\n"
      : "*Slack → Claude Code gateway*\n" +
        "Send any text in DM or @-mention me in a channel. Slash-prefix commands " +
        "(`/help`, `/status`, …) are supported as plain text — no manifest commands needed.\n" +
        "When Claude wants to run a tool you'll see Allow / Always / Deny / Never buttons.\n\n";
  return (
    intro +
    "*Commands*\n" +
    COMMAND_MENU.map((c) => `/${c.command} — ${c.description}`).join("\n")
  );
}

async function cmdStatus(deps: CommandDeps): Promise<void> {
  const { config, bootTime, chatId, userId, chatKind } = deps;
  const state = sessions.get(chatId);
  const u = users.get(userId);
  const wsTag = state.workspaceDir
    ? "_(chat)_"
    : u?.workspaceDir
      ? "_(user)_"
      : "_(default)_";
  const modeTag = state.permissionMode
    ? "_(chat)_"
    : u?.permissionMode
      ? "_(user)_"
      : "_(default)_";
  const modelEff = users.effectiveModel(chatId, userId);
  const modelDisplay = modelEff || "(SDK default)";
  const modelTag = state.model
    ? "_(chat)_"
    : u?.model && u.model.length > 0
      ? "_(user)_"
      : "_(default)_";
  const session = state.sessionId
    ? state.sessionId.slice(0, 8) + "…"
    : "(none)";
  const cost = (state.totalCostUsd ?? 0).toFixed(4);
  const allowCount = state.allowAlwaysTools?.length ?? 0;
  const denyCount = state.denyAlwaysTools?.length ?? 0;
  const v = users.voiceFor(userId);
  const voiceLine = `${v.replyMode}${v.tts.enabled ? "" : " (TTS off)"}`;
  const lines = [
    `*Workspace:* \`${users.effectiveWorkspace(chatId, userId, config.gatewayDir)}\` ${wsTag}`,
    `*Permission mode:* ${users.effectiveMode(chatId, userId)} ${modeTag}`,
    `*Model:* ${modelDisplay} ${modelTag}`,
    `*TZ:* ${users.tzFor(userId)}`,
    `*Voice reply:* ${voiceLine}`,
    ...(chatKind === "group" ? [`*Respond:* ${state.respondTo ?? "always"}`] : []),
    `*Session:* ${session}`,
    `*Cost:* $${cost}`,
    `*Budget:* ${budget.summaryLine(budget.statusFor(chatId, userId))}`,
    `*Always rules:* ${allowCount} allow / ${denyCount} deny`,
    `*User config:* \`data/config.json\` → \`users.${userId}\``,
    `*Booted:* ${new Date(bootTime).toISOString()}`,
    `*Transport:* ${deps.io.transport}`,
  ];
  await reply(deps, lines.join("\n"));
}

async function cmdMode(deps: CommandDeps, args: string[]): Promise<void> {
  const { chatId, userId, chatKind } = deps;
  const arg = args.join(" ").trim();
  const argLower = arg.toLowerCase();
  if (!arg) {
    const choices = [...VALID_PERMISSION_MODES].join(", ");
    await reply(
      deps,
      `Current permission mode: ${users.effectiveMode(chatId, userId)}\n` +
        `Usage: /mode <${choices}>\n` +
        `Shortcuts: acc/accept/edits → acceptEdits, byp/bypass/yolo → bypassPermissions\n` +
        `Or: /mode reset — clear ${chatKind === "group" ? "this chat's override" : "your default"}`,
      false,
    );
    return;
  }
  if (argLower === "reset" || argLower === "default-reset") {
    const scope = await writeOverride(chatKind, chatId, userId, {
      permissionMode: undefined,
    });
    await reply(
      deps,
      `✅ Permission mode cleared ${scopeNote(scope)}. Effective: ${users.effectiveMode(chatId, userId)}.`,
      false,
    );
    return;
  }
  const resolved = MODE_ALIASES[argLower];
  if (!resolved) {
    await reply(
      deps,
      `Unknown mode "${arg}". Choose: ${[...VALID_PERMISSION_MODES].join(", ")}`,
      false,
    );
    return;
  }
  const scope = await writeOverride(chatKind, chatId, userId, {
    permissionMode: resolved as PermissionMode,
  });
  await reply(
    deps,
    `✅ Permission mode set to *${resolved}* ${scopeNote(scope)}.`,
  );
}

async function cmdModel(deps: CommandDeps, args: string[]): Promise<void> {
  const { chatId, userId, chatKind } = deps;
  const arg = args.join(" ").trim().toLowerCase();
  if (!arg) {
    const current = users.effectiveModel(chatId, userId) || "(SDK default)";
    const choices = Object.keys(MODEL_ALIASES).join(", ");
    await reply(deps, `Current model: ${current}\nUsage: /model <${choices}>`, false);
    return;
  }
  if (!(arg in MODEL_ALIASES)) {
    await reply(
      deps,
      `Unknown model "${arg}". Choose: ${Object.keys(MODEL_ALIASES).join(", ")}`,
      false,
    );
    return;
  }
  const resolved = MODEL_ALIASES[arg]!;
  const scope = await writeOverride(chatKind, chatId, userId, {
    model: resolved || undefined,
  });
  await reply(
    deps,
    resolved
      ? `✅ Model set to \`${resolved}\` (${arg}) ${scopeNote(scope)}.`
      : `✅ Model reset to SDK default ${scopeNote(scope)}.`,
  );
}

async function cmdWorkspace(deps: CommandDeps, args: string[]): Promise<void> {
  const { config, chatId, userId, chatKind } = deps;
  const arg = args.join(" ").trim();
  if (!arg) {
    await reply(
      deps,
      `Current workspace: \`${users.effectiveWorkspace(chatId, userId, config.gatewayDir)}\`\n` +
        `Usage: /workspace <absolute-path>\n` +
        `Or: /workspace reset — clear ${chatKind === "group" ? "this chat's override" : "your default"}`,
    );
    return;
  }
  if (arg === "reset") {
    const scope = await writeOverride(chatKind, chatId, userId, {
      workspaceDir: undefined,
    });
    await reply(
      deps,
      `✅ Workspace cleared ${scopeNote(scope)}. Effective: ${users.effectiveWorkspace(chatId, userId, config.gatewayDir)}.`,
      false,
    );
    return;
  }
  const resolved = path.resolve(arg);
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      await reply(deps, `❌ Not a directory: ${resolved}`, false);
      return;
    }
  } catch {
    await reply(deps, `❌ Path does not exist: ${resolved}`, false);
    return;
  }
  const scope = await writeOverride(chatKind, chatId, userId, {
    workspaceDir: resolved,
  });
  await reply(deps, `✅ Workspace set to \`${resolved}\` ${scopeNote(scope)}.`);
}

async function cmdCloudexpert(deps: CommandDeps): Promise<void> {
  const { chatId, userId, chatKind } = deps;
  const target = "D:\\cloudexpert";
  try {
    const stat = await fs.stat(target);
    if (!stat.isDirectory()) {
      await reply(deps, `❌ Not a directory: ${target}`, false);
      return;
    }
  } catch {
    await reply(deps, `❌ Path does not exist: ${target}`, false);
    return;
  }
  const scope = await writeOverride(chatKind, chatId, userId, {
    workspaceDir: target,
  });
  await reply(deps, `✅ Workspace set to \`${target}\` ${scopeNote(scope)}.`);
}

/**
 * `/budget` — spend ceilings. The monthly cap follows the same chat-in-groups /
 * user-in-DMs scoping as /mode and /model (a shared group shouldn't spend the
 * owner's personal allowance). The per-turn cap is user-level only: it's a
 * runaway-loop guard, not a policy knob that sensibly differs per chat.
 */
async function cmdBudget(deps: CommandDeps, args: string[]): Promise<void> {
  const { chatId, userId, chatKind } = deps;
  const sub = (args[0] ?? "").toLowerCase();
  const value = (args[1] ?? "").toLowerCase();
  const status = budget.statusFor(chatId, userId);

  if (!sub) {
    const state = sessions.get(chatId);
    const capScope = state.budgetUsd
      ? "_(chat)_"
      : users.get(userId)?.budget?.monthlyUsd
        ? "_(user)_"
        : "";
    const lines = [
      `*Spend:* ${budget.summaryLine(status)} ${capScope}`.trimEnd(),
      `*Per-turn cap:* ${status.perTurnUsd ? `$${status.perTurnUsd.toFixed(2)}` : "none"}`,
      `*All-time (this chat):* $${(state.totalCostUsd ?? 0).toFixed(4)}`,
      "",
      "`/budget monthly <usd|off>` · `/budget turn <usd|off>`",
      `Warning fires at ${budget.WARN_PCT}% of the monthly cap; turns are refused at 100%.`,
    ];
    await reply(deps, lines.join("\n"));
    return;
  }

  if (sub !== "monthly" && sub !== "turn") {
    await reply(
      deps,
      'Usage: `/budget` · `/budget monthly <usd|off>` · `/budget turn <usd|off>`',
    );
    return;
  }

  const off = value === "off" || value === "none" || value === "0";
  let usd: number | undefined;
  if (!off) {
    usd = Number(value.replace(/^\$/, ""));
    if (!Number.isFinite(usd) || usd <= 0) {
      await reply(
        deps,
        `❌ "${args[1] ?? ""}" isn't a positive dollar amount. Try \`/budget ${sub} 50\` or \`/budget ${sub} off\`.`,
        false,
      );
      return;
    }
  }

  if (sub === "turn") {
    const existing = users.get(userId)?.budget ?? {};
    await users.update(userId, {
      budget: { ...existing, perTurnUsd: usd },
    });
    await reply(
      deps,
      usd === undefined
        ? "✅ Per-turn cap removed."
        : `✅ Per-turn cap set to *$${usd.toFixed(2)}* — a single turn stops itself there.`,
    );
    return;
  }

  if (chatKind === "group") {
    await sessions.update(chatId, { budgetUsd: usd });
    await reply(
      deps,
      usd === undefined
        ? "✅ Monthly cap cleared for this chat (falls back to your personal cap, if any)."
        : `✅ Monthly cap set to *$${usd.toFixed(2)}* for this chat. Spent so far: $${status.spentUsd.toFixed(2)}.`,
    );
    return;
  }
  // DM: write the user default and clear any chat-layer override so the new
  // value isn't silently shadowed — same rule as writeOverride().
  await sessions.update(chatId, { budgetUsd: undefined });
  const existing = users.get(userId)?.budget ?? {};
  await users.update(userId, { budget: { ...existing, monthlyUsd: usd } });
  await reply(
    deps,
    usd === undefined
      ? "✅ Monthly cap removed as your default."
      : `✅ Monthly cap set to *$${usd.toFixed(2)}* as your default. Spent so far: $${status.spentUsd.toFixed(2)}.`,
  );
}

function taskAgeString(ms: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

const TASK_ICONS: Record<string, string> = {
  queued: "⏳",
  running: "⚙️",
  paused: "⏸",
  done: "✅",
  failed: "❌",
  killed: "🛑",
  interrupted: "🔌",
};

/** `/bg <prompt>` — dispatch a detached task. */
async function cmdBg(deps: CommandDeps, args: string[]): Promise<void> {
  const prompt = args.join(" ").trim();
  if (!prompt) {
    await reply(
      deps,
      "*Background tasks*\n" +
        "`/bg <what to do>` — runs detached in its own git worktree, reports back when done.\n" +
        "`/bg --budget 10 <what to do>` — override the $" +
        `${taskRunner.TASK_BUDGET_DEFAULT_USD} default cap.\n\n` +
        "The chat stays live while it runs. `/tasks` lists them, `/task <id>` shows detail, `/kill <id>` stops one.\n" +
        "If it hits a tool it isn't trusted with, it pauses and asks — see `/trust`.",
    );
    return;
  }

  // Optional leading --budget <usd>.
  let budgetUsd: number | undefined;
  let body = prompt;
  const budgetMatch = /^--budget[= ]+(\d+(?:\.\d+)?)\s+([\s\S]+)$/.exec(prompt);
  if (budgetMatch) {
    budgetUsd = Number(budgetMatch[1]);
    body = budgetMatch[2]!.trim();
  }

  const gate = budget.check(deps.chatId, deps.userId);
  if (!gate.ok) {
    await reply(deps, gate.message!);
    return;
  }

  const { task, note } = await taskRunner.startTask({
    chatId: deps.chatId,
    chatKind: deps.chatKind,
    userId: deps.userId,
    transport: deps.io.transport,
    prompt: body,
    ...(budgetUsd !== undefined ? { budgetUsd } : {}),
  });

  const queued = taskRunner.isRunning(task.id)
    ? "started"
    : `queued (${taskRunner.queueDepth()} ahead)`;
  await reply(
    deps,
    `🎫 Task \`${task.id}\` ${queued} · budget $${task.budgetUsd.toFixed(2)}\n` +
      `_${escMd(previewPrompt(body, 140))}_\n\n${note}`,
  );
}

async function cmdTasks(deps: CommandDeps): Promise<void> {
  const rows = tasks.list(deps.chatId).slice(0, 12);
  if (rows.length === 0) {
    await reply(
      deps,
      "No background tasks in this chat. Start one with `/bg <what to do>`.",
    );
    return;
  }
  const lines = ["*Background tasks*", ""];
  for (const t of rows) {
    const icon = TASK_ICONS[t.status] ?? "•";
    const age = t.endedAt
      ? `${taskAgeString(t.endedAt)} ago`
      : `${taskAgeString(t.startedAt ?? t.createdAt)} running`;
    lines.push(
      `${icon} \`${t.id}\` ${t.status} · ${age} · $${(t.costUsd ?? 0).toFixed(2)}`,
    );
    lines.push(`   _${escMd(previewPrompt(t.prompt, 70))}_`);
    if (t.status === "paused" && t.pausedOn) {
      lines.push(`   ⏸ waiting on *${t.pausedOn.tool}*`);
    }
    if (t.worktree) lines.push(`   \`${t.worktree.branch}\``);
  }
  lines.push("", "`/task <id>` for detail · `/kill <id>` to stop");
  await reply(deps, lines.join("\n"));
}

async function cmdTask(deps: CommandDeps, args: string[]): Promise<void> {
  const id = (args[0] ?? "").trim();
  if (!id) {
    await reply(deps, "Usage: `/task <id>` — ids come from `/tasks`.");
    return;
  }
  const found = tasks.resolve(id);
  if (found === "ambiguous") {
    await reply(deps, `❓ \`${escMd(id)}\` matches more than one task.`);
    return;
  }
  if (!found) {
    await reply(deps, `❌ No task matching \`${escMd(id)}\`.`);
    return;
  }
  if (found.chatId !== deps.chatId) {
    await reply(deps, "That task belongs to another chat.");
    return;
  }
  const lines = [
    `${TASK_ICONS[found.status] ?? "•"} *Task \`${found.id}\`* — ${found.status}`,
    `*Prompt:* _${escMd(previewPrompt(found.prompt, 300))}_`,
    `*Workspace:* \`${found.workspaceDir}\``,
    ...(found.worktree
      ? [`*Branch:* \`${found.worktree.branch}\` (from \`${found.worktree.baseBranch}\`)`]
      : ["*Isolation:* none (ran in place)"]),
    `*Cost:* $${(found.costUsd ?? 0).toFixed(4)} of $${found.budgetUsd.toFixed(2)}`,
    `*Started:* ${found.startedAt ? `${taskAgeString(found.startedAt)} ago` : "not yet"}`,
    ...(found.sessionId ? [`*Session:* \`${found.sessionId}\``] : []),
  ];
  if (found.pausedOn) {
    lines.push(
      "",
      `⏸ *Waiting on ${found.pausedOn.tool}* since ${taskAgeString(found.pausedOn.since)} ago`,
      "```",
      previewPrompt(found.pausedOn.inputSummary, 300),
      "```",
    );
  }
  if (found.progress) lines.push("", `*Last progress:* _${escMd(found.progress)}_`);
  if (found.error) lines.push("", `*Error:* \`${escMd(previewPrompt(found.error, 300))}\``);
  if (found.result) {
    lines.push("", "*Result:*", previewPrompt(found.result, 1200));
  }
  await reply(deps, lines.join("\n"));
}

async function cmdKill(deps: CommandDeps, args: string[]): Promise<void> {
  const id = (args[0] ?? "").trim();
  if (!id) {
    await reply(deps, "Usage: `/kill <id>` · `/kill all`");
    return;
  }
  if (id.toLowerCase() === "all") {
    const mine = tasks
      .list(deps.chatId)
      .filter((t) => !tasks.isTerminal(t.status));
    for (const t of mine) {
      taskRunner.killTask(t.id);
      await tasks.update(t.id, { status: "killed", endedAt: Date.now() });
    }
    await reply(
      deps,
      mine.length > 0
        ? `🛑 Stopped ${mine.length} task(s). Worktrees kept — discard from each report.`
        : "Nothing running.",
      false,
    );
    return;
  }
  const found = tasks.resolve(id);
  if (found === "ambiguous" || !found) {
    await reply(deps, `❌ ${found === "ambiguous" ? "Ambiguous" : "Unknown"} task \`${escMd(id)}\`.`);
    return;
  }
  if (found.chatId !== deps.chatId) {
    await reply(deps, "That task belongs to another chat.");
    return;
  }
  taskRunner.killTask(found.id);
  if (!tasks.isTerminal(found.status)) {
    await tasks.update(found.id, {
      status: "killed",
      endedAt: Date.now(),
      pausedOn: undefined,
    });
  }
  await reply(
    deps,
    `🛑 Task \`${found.id}\` stopped.` +
      (found.worktree
        ? ` Branch \`${found.worktree.branch}\` kept — review or discard it from the task's report.`
        : ""),
  );
}

const WATCH_USAGE =
  "*Watchers* — fire a background task when something changes.\n" +
  "`/watch add <kind> [target] -- <prompt>`\n" +
  "`/watch` · `/watch test <id>` · `/watch pause <id>` · `/watch resume <id>` · `/watch rm <id>`\n\n" +
  "*Kinds*\n" +
  "• `git [branch]` — a new commit lands\n" +
  "• `fs <path>` — a file or directory changes\n" +
  "• `http <url>` — the response body or status changes\n" +
  "• `log <path>::<regex>` — a matching line is appended\n\n" +
  "*Examples*\n" +
  "`/watch add git -- review the new commit and flag anything risky`\n" +
  "`/watch add http https://api.example.com/health -- investigate the health change`\n" +
  "`/watch add log data/logs/today.jsonl::error -- triage this error`\n\n" +
  "_The first check only records a baseline, so adding a watcher never fires on what's already there. Each fire creates a task with its own worktree and budget._";

async function cmdWatch(deps: CommandDeps, args: string[]): Promise<void> {
  const { chatId, userId, chatKind, config } = deps;
  const sub = (args[0] ?? "").toLowerCase();

  if (sub === "add") {
    const rest = args.slice(1);
    const sepIndex = rest.findIndex((a) => a === "--");
    if (sepIndex < 0) {
      await reply(deps, `❌ Missing \`--\` before the prompt.\n\n${WATCH_USAGE}`);
      return;
    }
    const kind = (rest[0] ?? "").toLowerCase() as watchers.WatcherKind;
    if (!["git", "fs", "http", "log"].includes(kind)) {
      await reply(deps, `❌ Unknown kind "${escMd(rest[0] ?? "")}".\n\n${WATCH_USAGE}`);
      return;
    }
    const target = rest.slice(1, sepIndex).join(" ").trim();
    const prompt = rest.slice(sepIndex + 1).join(" ").trim();
    if (!prompt) {
      await reply(deps, "❌ The prompt after `--` is empty.");
      return;
    }
    const workspaceDir = users.effectiveWorkspace(chatId, userId, config.gatewayDir);
    const problem = await watcherSources.validateTarget(kind, target, workspaceDir);
    if (problem) {
      await reply(deps, `❌ ${escMd(problem)}`);
      return;
    }
    const w = await watchers.create({
      chatId,
      chatKind,
      userId,
      transport: deps.io.transport,
      kind,
      target,
      prompt,
      workspaceDir,
      intervalSec: watchers.DEFAULT_INTERVAL_SEC[kind],
    });
    await reply(
      deps,
      `👀 Watcher \`${w.id}\` added — *${kind}*${target ? ` \`${escMd(target)}\`` : ""}, ` +
        `checked every ${w.intervalSec}s in \`${workspaceDir}\`.\n` +
        `_${escMd(previewPrompt(prompt, 120))}_\n\n` +
        "Baseline recorded on the first check; it fires on the next change.",
    );
    return;
  }

  if (sub === "test" || sub === "pause" || sub === "resume" || sub === "rm" || sub === "delete") {
    const id = (args[1] ?? "").trim();
    if (!id) {
      await reply(deps, `Usage: \`/watch ${sub} <id>\``);
      return;
    }
    const found = watchers.resolve(id);
    if (found === "ambiguous") {
      await reply(deps, `❓ \`${escMd(id)}\` matches more than one watcher.`);
      return;
    }
    if (!found || found.chatId !== chatId) {
      await reply(deps, `❌ No watcher \`${escMd(id)}\` in this chat.`);
      return;
    }
    if (sub === "test") {
      const result = await watcherTicker.testOne(found.id);
      await reply(
        deps,
        result.ok
          ? `👀 \`${found.id}\` reads: ${escMd(result.detail.slice(0, 500))}\n\n` +
              (result.changed
                ? "_This differs from the last baseline — it would fire on the next tick._"
                : "_Same as the recorded baseline — nothing would fire._")
          : `❌ \`${found.id}\` failed: ${escMd(result.error.slice(0, 300))}`,
      );
      return;
    }
    if (sub === "rm" || sub === "delete") {
      await watchers.remove(found.id);
      await reply(deps, `🗑 Watcher \`${found.id}\` removed.`);
      return;
    }
    await watchers.update(found.id, { enabled: sub === "resume" });
    await reply(
      deps,
      sub === "resume"
        ? `▶️ Watcher \`${found.id}\` resumed.`
        : `⏸ Watcher \`${found.id}\` paused (kept, never fires).`,
    );
    return;
  }

  if (sub && sub !== "list") {
    await reply(deps, `Unknown subcommand "${escMd(sub)}".\n\n${WATCH_USAGE}`);
    return;
  }

  const rows = watchers.list(chatId);
  if (rows.length === 0) {
    await reply(deps, WATCH_USAGE);
    return;
  }
  const lines = [`*${rows.length} watcher(s)*`, ""];
  for (const w of rows) {
    lines.push(
      `${w.enabled ? "👀" : "⏸"} \`${w.id}\` *${w.kind}*${w.target ? ` \`${escMd(previewPrompt(w.target, 50))}\`` : ""} · every ${w.intervalSec}s`,
    );
    lines.push(`   _${escMd(previewPrompt(w.prompt, 70))}_`);
    const bits: string[] = [];
    if (w.fireCount) bits.push(`fired ${w.fireCount}×`);
    if (w.lastFiredAt) bits.push(`last ${taskAgeString(w.lastFiredAt)} ago`);
    if (w.lastKey === undefined) bits.push("awaiting baseline");
    if (w.lastError) bits.push(`⚠️ ${previewPrompt(w.lastError, 60)}`);
    if (bits.length > 0) lines.push(`   ${bits.join(" · ")}`);
  }
  lines.push("", "`/watch test <id>` · `/watch pause <id>` · `/watch rm <id>`");
  await reply(deps, lines.join("\n"));
}

function ageString(mtimeMs: number, now = Date.now()): string {
  const sec = Math.max(0, Math.floor((now - mtimeMs) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

async function cmdResume(deps: CommandDeps, args: string[]): Promise<void> {
  const { chatId, userId, config } = deps;
  const arg = args.join(" ").trim();
  const argLower = arg.toLowerCase();
  const state = sessions.get(chatId);
  const ws = users.effectiveWorkspace(chatId, userId, config.gatewayDir);

  if (!arg) {
    const list = await listSessions(ws, 5);
    const lines: string[] = [];
    const current = state.sessionId;
    if (current) {
      lines.push(`*Current session:* \`${current}\``);
      lines.push(`Resume in CLI: \`claude --resume ${current}\``);
    } else {
      lines.push("*Current session:* _(none)_");
    }
    lines.push("");
    if (list.length === 0) {
      lines.push(`No sessions found in \`${projectsDirFor(ws)}\`.`);
    } else {
      lines.push(`*Recent sessions* for \`${ws}\`:`);
      for (const s of list) {
        const marker = s.id === current ? " ← current" : "";
        const head = `• \`${s.id.slice(0, 8)}\` (${ageString(s.mtimeMs)})${marker}`;
        if (s.preview) {
          lines.push(`${head}\n  _${escMd(previewPrompt(s.preview, 80))}_`);
        } else {
          lines.push(head);
        }
      }
    }
    lines.push("");
    lines.push("Usage: `/resume <id-or-prefix>` · `/resume latest` · `/resume reset`");
    lines.push(
      "_Tip: send a session id (or its first 8 chars) as a plain message to switch — no command needed._",
    );
    await reply(deps, lines.join("\n"));
    return;
  }

  if (argLower === "reset") {
    await sessions.update(chatId, { sessionId: undefined });
    await reply(deps, "✅ Session cleared.", false);
    return;
  }

  if (argLower === "latest" || argLower === "host") {
    const list = await listSessions(ws, 1);
    const top = list[0];
    if (!top) {
      await reply(
        deps,
        `❌ No sessions found in \`${projectsDirFor(ws)}\`. Nothing to resume.`,
      );
      return;
    }
    await sessions.update(chatId, { sessionId: top.id });
    await reply(
      deps,
      `↪ Will resume \`${top.id}\` (${ageString(top.mtimeMs)}) on your next message.`,
    );
    return;
  }

  if (!/^[0-9a-f-]{4,}$/i.test(arg)) {
    await reply(deps, "❌ That doesn't look like a session id or prefix.", false);
    return;
  }

  const resolved = await findSessionByPrefix(ws, arg);
  if (resolved === "ambiguous") {
    await reply(
      deps,
      `❌ Prefix \`${arg}\` matches more than one session. Use more characters.`,
    );
    return;
  }
  if (!resolved) {
    await reply(deps, `❌ No session matching \`${arg}\` in this workspace.`);
    return;
  }
  await sessions.update(chatId, { sessionId: resolved });
  await reply(deps, `↪ Will resume \`${resolved}\` on your next message.`);
}

async function cmdRules(deps: CommandDeps, args: string[]): Promise<void> {
  const { chatId } = deps;
  const sub = (args[0] ?? "").toLowerCase();
  const rest = args.slice(1).join(" ").trim();

  const usage =
    "`/trust` — list rules\n" +
    "`/trust allow <rule>` · `/trust deny <rule>`\n" +
    "`/trust revoke <n>` · `/trust clear`\n" +
    "`/trust grant <30m|2h>` — trust everything for a while\n" +
    "`/trust ungrant`\n\n" +
    "*Rule syntax:* `Tool` (any input) or `Tool(pattern)`\n" +
    "  `Bash(npm run *)` · `Write(src/**)` · `WebFetch(api.github.com)`\n" +
    "  Paths are workspace-relative; `*` stops at `/`, `**` crosses it.\n" +
    "  Deny beats allow, and both beat an active grant.";

  if (sub === "clear") {
    await sessions.clearTrust(chatId);
    await reply(deps, "🧹 Cleared all trust rules and grants for this chat.", false);
    return;
  }

  if (sub === "allow" || sub === "deny") {
    const parsed = trust.parseRule(rest);
    if (!parsed) {
      await reply(deps, `❌ Couldn't parse \`${escMd(rest)}\`.\n\n${usage}`);
      return;
    }
    const rule = await sessions.addTrustRule(
      chatId,
      sub,
      parsed.tool,
      parsed.arg,
    );
    await reply(
      deps,
      `${sub === "allow" ? "✅" : "⛔"} Rule added: \`${trust.formatRule(rule)}\``,
    );
    return;
  }

  if (sub === "revoke" || sub === "rm") {
    const n = Number(rest);
    if (!Number.isInteger(n) || n < 1) {
      await reply(deps, "Usage: `/trust revoke <n>` — the number shown by `/trust`.");
      return;
    }
    const removed = await sessions.removeTrustRuleAt(chatId, n);
    await reply(
      deps,
      removed
        ? `🗑 Removed \`${trust.formatRule(removed)}\`.`
        : `❌ No rule #${n}.`,
    );
    return;
  }

  if (sub === "grant") {
    const ms = trust.parseDuration(rest || "30m");
    if (ms === null) {
      await reply(deps, "Usage: `/trust grant 30m` · `/trust grant 2h` (max 24h).");
      return;
    }
    const until = Date.now() + ms;
    await sessions.addGrant(chatId, { untilMs: until, scope: "chat" });
    await reply(
      deps,
      `🔓 Trusting every tool call in this chat for ${Math.round(ms / 60000)} minutes ` +
        `(until ${new Date(until).toISOString().slice(11, 16)} UTC).\n` +
        "Standing `deny` rules still apply. `/trust ungrant` ends it early.",
    );
    return;
  }

  if (sub === "ungrant") {
    await sessions.clearGrants(chatId);
    await reply(deps, "🔒 Grants cleared — prompts are back on.", false);
    return;
  }

  if (sub && sub !== "list") {
    await reply(deps, `Unknown subcommand "${escMd(sub)}".\n\n${usage}`);
    return;
  }

  const rules = sessions.trustRulesFor(chatId);
  const grants = sessions.get(chatId).grants ?? [];
  const live = grants.filter((g) => g.untilMs > Date.now());
  const lines = [trust.formatRuleTable(rules)];
  if (live.length > 0) {
    const mins = Math.max(
      ...live.map((g) => Math.round((g.untilMs - Date.now()) / 60000)),
    );
    lines.push("", `🔓 *Active grant:* everything allowed for ${mins}m more.`);
  }
  lines.push("", usage);
  await reply(deps, lines.join("\n"));
}

async function cmdRespond(deps: CommandDeps, args: string[]): Promise<void> {
  const { chatId, chatKind } = deps;
  if (chatKind !== "group") {
    await reply(deps, "This command only applies in groups. DMs always respond.", false);
    return;
  }
  const arg = args.join(" ").trim().toLowerCase();
  const current = sessions.get(chatId).respondTo ?? "always";
  if (!arg) {
    const choices = [...VALID_RESPOND_MODES].join(", ");
    await reply(
      deps,
      `Group respond mode: ${current}\n` +
        `Usage: /respond <${choices}>\n` +
        `always = respond to every message (default)\n` +
        `mention = respond only when @-mentioned or replied to\n` +
        `reply = respond only when someone replies to a bot message`,
      false,
    );
    return;
  }
  if (!VALID_RESPOND_MODES.has(arg as RespondMode)) {
    await reply(
      deps,
      `Unknown mode "${arg}". Choose: ${[...VALID_RESPOND_MODES].join(", ")}`,
      false,
    );
    return;
  }
  await sessions.update(chatId, { respondTo: arg as RespondMode });
  await reply(deps, `✅ Group respond mode set to *${arg}*.`);
}

async function cmdVoice(deps: CommandDeps, args: string[]): Promise<void> {
  const { userId } = deps;
  const arg = args.join(" ").trim().toLowerCase();
  const current = users.voiceFor(userId);
  const transport = deps.io.transport;
  if (!arg) {
    const choices = [...VALID_VOICE_REPLY_MODES].join(", ");
    if (transport === "telegram") {
      const ttsState = current.tts.enabled
        ? `enabled (${current.tts.backend} ${current.tts.model}, voice=${current.tts.voice})`
        : "disabled";
      await reply(
        deps,
        `Voice reply mode: ${current.replyMode}\n` +
          `TTS: ${ttsState}\n` +
          `Usage: /voice <${choices}>\n` +
          `text = always reply with text only\n` +
          `voice = also send a voice reply on every turn\n` +
          `auto = voice reply only when you sent a voice message\n` +
          `(TTS itself stays controlled by voice.tts.enabled in your config.)`,
        false,
      );
    } else {
      await reply(
        deps,
        `Voice reply mode: ${current.replyMode}\nUsage: /voice <${choices}>\n(Note: Slack voice/TTS support is not wired in v1.)`,
        false,
      );
    }
    return;
  }
  if (!VALID_VOICE_REPLY_MODES.has(arg as VoiceReplyMode)) {
    await reply(
      deps,
      `Unknown mode "${arg}". Choose: ${[...VALID_VOICE_REPLY_MODES].join(", ")}`,
      false,
    );
    return;
  }
  const next = arg as VoiceReplyMode;
  const existingVoice = users.get(userId)?.voice ?? {};
  await users.update(userId, {
    voice: { ...existingVoice, replyMode: next },
  });
  const note =
    transport === "telegram" && next !== "text" && !current.tts.enabled
      ? "\n\n⚠️ TTS is currently off — set `voice.tts.enabled: true` in your config to actually hear voice replies (and add OPENAI_API_KEY to env)."
      : transport === "slack" && next !== "text"
        ? " (Slack TTS is a follow-up.)"
        : "";
  await reply(deps, `✅ Voice reply mode set to *${next}* as your default.${note}`);
}

async function cmdRedo(deps: CommandDeps): Promise<void> {
  const last = sessions.get(deps.chatId).lastPrompt;
  if (!last || last.trim().length === 0) {
    await reply(
      deps,
      "No previous message to re-run. Send a message first, then `/redo` re-fires it.",
      false,
    );
    return;
  }
  await reply(deps, `↻ Re-running: _${escMd(previewPrompt(last, 120))}_`);
  deps.kickOff(last);
}

async function cmdWs(deps: CommandDeps, args: string[]): Promise<void> {
  const { config, chatId, userId, chatKind } = deps;
  if (chatKind === "group") {
    await reply(
      deps,
      "Bookmarks are personal — DM me to manage them. In groups, use `/workspace <path>`.",
      false,
    );
    return;
  }
  const sub = (args[0] ?? "list").toLowerCase();
  const u = users.get(userId);
  const bookmarks = { ...(u?.bookmarks ?? {}) };

  if (sub === "" || sub === "list" || sub === "ls") {
    const names = Object.keys(bookmarks).sort();
    if (names.length === 0) {
      await reply(
        deps,
        "No bookmarks yet.\n" +
          "`/ws save <name>` — save the current workspace under a name\n" +
          "`/ws save <name> <path>` — save a specific path\n" +
          "`/ws use <name>` — switch to a saved bookmark\n" +
          "`/ws delete <name>` — remove a bookmark",
      );
      return;
    }
    const current = users.effectiveWorkspace(chatId, userId, config.gatewayDir);
    const lines = [`*${names.length} bookmark(s)*:`, ""];
    for (const name of names) {
      const p = bookmarks[name]!;
      const marker = p === current ? " ← current" : "";
      lines.push(`• \`${name}\` → \`${p}\`${marker}`);
    }
    lines.push("");
    lines.push("`/ws use <name>` · `/ws save <name> [path]` · `/ws delete <name>`");
    await reply(deps, lines.join("\n"));
    return;
  }

  if (sub === "save") {
    const name = args[1];
    if (!name) {
      await reply(
        deps,
        "Usage: `/ws save <name> [path]` — path defaults to the current workspace.",
        false,
      );
      return;
    }
    if (!BOOKMARK_NAME_RE.test(name)) {
      await reply(
        deps,
        `❌ Invalid name "${name}". Use letters, digits, underscore, or hyphen (up to 32 chars).`,
        false,
      );
      return;
    }
    const rawPath = args.slice(2).join(" ").trim();
    const target = rawPath
      ? path.resolve(rawPath)
      : users.effectiveWorkspace(chatId, userId, config.gatewayDir);
    try {
      const stat = await fs.stat(target);
      if (!stat.isDirectory()) {
        await reply(deps, `❌ Not a directory: \`${target}\``, false);
        return;
      }
    } catch {
      await reply(deps, `❌ Path does not exist: \`${target}\``, false);
      return;
    }
    bookmarks[name] = target;
    await users.update(userId, { bookmarks });
    await reply(deps, `🔖 Saved bookmark \`${name}\` → \`${target}\`.`);
    return;
  }

  if (sub === "use") {
    const name = args[1];
    if (!name) {
      await reply(deps, "Usage: `/ws use <name>`", false);
      return;
    }
    const target = bookmarks[name];
    if (!target) {
      await reply(deps, `No bookmark named \`${name}\`. Try \`/ws list\`.`);
      return;
    }
    try {
      const stat = await fs.stat(target);
      if (!stat.isDirectory()) {
        await reply(
          deps,
          `❌ Bookmark \`${name}\` points at \`${target}\` which is no longer a directory. Re-save it.`,
          false,
        );
        return;
      }
    } catch {
      await reply(
        deps,
        `❌ Bookmark \`${name}\` points at \`${target}\` which no longer exists. Re-save it.`,
        false,
      );
      return;
    }
    const scope = await writeOverride(chatKind, chatId, userId, {
      workspaceDir: target,
    });
    await reply(
      deps,
      `✅ Workspace set to \`${target}\` (\`${name}\`) ${scopeNote(scope)}.`,
    );
    return;
  }

  if (sub === "delete" || sub === "rm" || sub === "del") {
    const name = args[1];
    if (!name) {
      await reply(deps, "Usage: `/ws delete <name>`", false);
      return;
    }
    if (!(name in bookmarks)) {
      await reply(deps, `No bookmark named \`${name}\`.`);
      return;
    }
    delete bookmarks[name];
    await users.update(userId, { bookmarks });
    await reply(deps, `🗑️ Removed bookmark \`${name}\`.`, false);
    return;
  }

  await reply(
    deps,
    `Unknown subcommand "${sub}". Use list / save / use / delete.`,
    false,
  );
}

async function cmdCron(deps: CommandDeps, args: string[]): Promise<void> {
  const { chatId } = deps;
  const sub = (args[0] ?? "list").toLowerCase();
  if (sub === "list" || sub === "ls" || sub === "") {
    const list = crons.list(chatId).sort((a, b) => a.createdAt - b.createdAt);
    if (list.length === 0) {
      await reply(
        deps,
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
    await reply(deps, lines.join("\n"));
    return;
  }
  const id = args[1];
  if (!id) {
    await reply(
      deps,
      "Usage:\n  /cron list\n  /cron pause <id>\n  /cron resume <id>\n  /cron delete <id>",
      false,
    );
    return;
  }
  const c = crons.get(id);
  if (!c || c.chatId !== chatId) {
    await reply(deps, `No cron \`${id}\` in this chat.`);
    return;
  }
  if (sub === "pause") {
    if (!c.enabled) {
      await reply(deps, `Cron \`${id}\` is already paused.`);
      return;
    }
    await crons.update(id, { enabled: false });
    await reply(deps, `⏸ Paused cron \`${id}\`.`);
    return;
  }
  if (sub === "resume") {
    if (c.enabled) {
      await reply(deps, `Cron \`${id}\` is already enabled.`);
      return;
    }
    await crons.update(id, { enabled: true });
    await reply(deps, `▶ Resumed cron \`${id}\`.`);
    return;
  }
  if (sub === "delete" || sub === "rm") {
    await crons.remove(id);
    await reply(deps, `🗑️ Deleted cron \`${id}\`.`);
    return;
  }
  await reply(
    deps,
    `Unknown subcommand "${sub}". Use list / pause / resume / delete.`,
    false,
  );
}

const INIT_PROMPT =
  "Analyze the codebase rooted at this working directory and create a CLAUDE.md file that documents:\n" +
  "- Project purpose and high-level architecture\n" +
  "- Key files and modules\n" +
  "- Build, run, test commands (from package.json or equivalent)\n" +
  "- Conventions and gotchas a new contributor should know\n\n" +
  "If CLAUDE.md already exists, update it rather than overwriting.";

const COMPACT_PROMPT =
  "Compact our conversation: summarize what we have established so far, what we are currently working on, and any open questions, then continue from that summary.";

/**
 * Run a slash command. Returns `true` if the name was recognized (handled or
 * rejected with a usage hint), `false` to let the caller fall through to a
 * normal Claude turn.
 */
export async function runCommand(
  deps: CommandDeps,
  name: string,
  args: string[],
): Promise<boolean> {
  const cmd = name.toLowerCase();
  switch (cmd) {
    case "help":
    case "start":
      await reply(deps, helpText(deps.io.transport));
      return true;
    case "status":
      await cmdStatus(deps);
      return true;
    case "mode":
      await cmdMode(deps, args);
      return true;
    case "model":
      await cmdModel(deps, args);
      return true;
    case "workspace":
      await cmdWorkspace(deps, args);
      return true;
    case "ws":
      await cmdWs(deps, args);
      return true;
    case "cloudexpert":
      await cmdCloudexpert(deps);
      return true;
    case "init":
      deps.kickOff(INIT_PROMPT);
      return true;
    case "compact":
      deps.kickOff(COMPACT_PROMPT);
      return true;
    case "resume":
      await cmdResume(deps, args);
      return true;
    case "new": {
      deps.abort("user_new");
      await sessions.update(deps.chatId, { sessionId: undefined });
      await reply(
        deps,
        "🆕 Session cleared. Next message starts a fresh Claude session (tool rules preserved).",
        false,
      );
      return true;
    }
    case "cancel": {
      const aborted = deps.abort("user_cancel");
      await reply(
        deps,
        aborted
          ? "🛑 Turn cancelled. Session kept — your next message resumes the same Claude conversation."
          : "Nothing to cancel — no turn is running.",
        false,
      );
      return true;
    }
    case "cost": {
      const state = sessions.get(deps.chatId);
      const cost = state.totalCostUsd ?? 0;
      const status = budget.statusFor(deps.chatId, deps.userId);
      await reply(
        deps,
        `💰 *This chat:* $${cost.toFixed(4)} all-time\n` +
          `*This month:* ${budget.summaryLine(status)}`,
      );
      return true;
    }
    case "budget":
      await cmdBudget(deps, args);
      return true;
    case "bg":
      await cmdBg(deps, args);
      return true;
    case "tasks":
      await cmdTasks(deps);
      return true;
    case "task":
      await cmdTask(deps, args);
      return true;
    case "kill":
      await cmdKill(deps, args);
      return true;
    case "redo":
      await cmdRedo(deps);
      return true;
    case "rules":
    case "trust":
      await cmdRules(deps, args);
      return true;
    case "respond":
      await cmdRespond(deps, args);
      return true;
    case "voice":
      await cmdVoice(deps, args);
      return true;
    case "cron":
      await cmdCron(deps, args);
      return true;
    case "watch":
      await cmdWatch(deps, args);
      return true;
    default:
      return false;
  }
}

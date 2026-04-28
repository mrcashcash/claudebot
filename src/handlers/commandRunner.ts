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

async function cmdResume(deps: CommandDeps, args: string[]): Promise<void> {
  const { chatId } = deps;
  const arg = args.join(" ").trim();
  const state = sessions.get(chatId);
  if (!arg) {
    const current = state.sessionId ?? "(none)";
    await reply(
      deps,
      `Current session: \`${current}\`\nUsage: /resume <sessionId>\nOr: /resume reset`,
    );
    return;
  }
  if (arg === "reset") {
    await sessions.update(chatId, { sessionId: undefined });
    await reply(deps, "✅ Session cleared.", false);
    return;
  }
  if (!/^[0-9a-fA-F-]{8,}$/.test(arg)) {
    await reply(deps, "❌ That doesn't look like a session id.", false);
    return;
  }
  await sessions.update(chatId, { sessionId: arg });
  await reply(deps, `✅ Will resume session \`${arg}\` on next message.`);
}

async function cmdRules(deps: CommandDeps, args: string[]): Promise<void> {
  const { chatId } = deps;
  const arg = args.join(" ").trim();
  const state = sessions.get(chatId);
  if (arg === "clear") {
    await sessions.update(chatId, {
      allowAlwaysTools: [],
      denyAlwaysTools: [],
    });
    await reply(deps, "🧹 Cleared all always-allow/deny rules for this chat.", false);
    return;
  }
  const allow = state.allowAlwaysTools ?? [];
  const deny = state.denyAlwaysTools ?? [];
  if (allow.length === 0 && deny.length === 0) {
    await reply(
      deps,
      "No always-allow/deny rules set. Tap *Always* on a permission prompt to add one.\nUse `/rules clear` to wipe them.",
    );
    return;
  }
  const lines = [
    "*Always-allow:*",
    ...(allow.length > 0 ? allow.map((t) => `  • ${t}`) : ["  _(none)_"]),
    "",
    "*Always-deny:*",
    ...(deny.length > 0 ? deny.map((t) => `  • ${t}`) : ["  _(none)_"]),
  ];
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
      await reply(deps, `💰 Cumulative cost for this chat: $${cost.toFixed(4)}`, false);
      return true;
    }
    case "rules":
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
    default:
      return false;
  }
}

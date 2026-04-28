import type { PermissionMode } from "../config.ts";
import * as sessions from "../state/sessions.ts";
import * as users from "../state/users.ts";

/**
 * Building blocks shared by both transports' command dispatchers
 * ([src/telegram/commands.ts](../telegram/commands.ts) and
 * [src/slack/commands.ts](../slack/commands.ts)). Each transport has its own
 * arg-parsing/UI code, but the alias maps and the chat-vs-user override write
 * helper live here so behavior stays in lockstep.
 */

export type ChatKind = "dm" | "group";

type OverrideField = "workspaceDir" | "permissionMode" | "model";
type OverridePatch = Partial<Pick<sessions.ChatState, OverrideField>>;

/**
 * Apply a workspace/mode/model patch to the right scope: chat-layer in
 * groups (so each group gets its own settings), user-layer in DMs (so the
 * user's "personal default" stays meaningful — and we clear any stale
 * chat-layer override on the same fields so the user-layer write isn't
 * silently shadowed).
 */
export async function writeOverride(
  chatKind: ChatKind,
  chatId: string,
  userId: number | string,
  patch: OverridePatch,
): Promise<"chat" | "user"> {
  if (chatKind === "group") {
    await sessions.update(chatId, patch);
    return "chat";
  }
  const clearChatPatch: OverridePatch = {};
  for (const key of Object.keys(patch) as OverrideField[]) {
    clearChatPatch[key] = undefined;
  }
  await sessions.update(chatId, clearChatPatch);
  await users.update(userId, patch);
  return "user";
}

export function scopeNote(scope: "chat" | "user"): string {
  return scope === "chat" ? "for this chat" : "as your default";
}

export const MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-4-7",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
  default: "",
};

// Shortcut → canonical PermissionMode. Keys are lowercased; the handler
// lowercases user input before looking up. Keep canonical names here too so
// the exact spelling still works.
export const MODE_ALIASES: Record<string, PermissionMode> = {
  default: "default",
  acceptedits: "acceptEdits",
  accept: "acceptEdits",
  acc: "acceptEdits",
  edits: "acceptEdits",
  bypasspermissions: "bypassPermissions",
  bypass: "bypassPermissions",
  byp: "bypassPermissions",
  yolo: "bypassPermissions",
  plan: "plan",
};

export const COMMAND_MENU = [
  { command: "help", description: "Show available commands" },
  { command: "status", description: "Workspace, model, session, cost" },
  {
    command: "model",
    description: "Switch model: opus / sonnet / haiku / default",
  },
  {
    command: "mode",
    description:
      "Permission mode: default / acceptEdits / bypassPermissions / plan",
  },
  {
    command: "workspace",
    description: "Set Claude's working directory for this chat",
  },
  {
    command: "cloudexpert",
    description: "Quick set workspace to D:\\cloudexpert",
  },
  {
    command: "init",
    description: "Ask Claude to analyze the workspace and write CLAUDE.md",
  },
  {
    command: "compact",
    description: "Summarize and continue from a compact form",
  },
  { command: "resume", description: "Resume a specific session id" },
  {
    command: "new",
    description: "Start a fresh Claude session (keeps tool rules)",
  },
  {
    command: "cancel",
    description: "Stop the current Claude turn (keeps session)",
  },
  { command: "cost", description: "Show cumulative cost for this chat" },
  {
    command: "rules",
    description: "List always-allow / always-deny tool rules",
  },
  {
    command: "cron",
    description: "List / pause / resume / delete scheduled crons",
  },
  {
    command: "voice",
    description: "Voice reply mode: text / voice / auto",
  },
  {
    command: "respond",
    description: "Group gate: always / mention / reply (groups only)",
  },
] as const;

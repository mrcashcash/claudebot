import fs from "node:fs/promises";
import path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { TurnIO } from "../handlers/turnIO.ts";
import { log, logError } from "../state/logger.ts";

export const SEND_FILE_MAX_BYTES = 100 * 1024 * 1024;

export function buildSendFileSystemGuidance(transport: TurnIO["transport"]): string {
  const transportNote =
    transport === "telegram"
      ? "On Telegram the cloud Bot API caps a single document at 50 MB; files between 50 and 100 MB are auto-split into ~49 MB parts that the user can reassemble with `cat` (Linux/Mac) or `copy /b` (Windows). On Slack a single upload covers the full range."
      : "Slack files.uploadV2 handles the full 0–100 MB range in a single upload.";
  return `When the user wants you to deliver a local file (build artifact, report, screenshot, generated asset, log bundle…) back to the chat, use the \`mcp__claudebot__send_file\` tool with a path inside the current workspace. Files up to 100 MB are accepted. Paths outside the workspace, missing files, directories, and oversize files are rejected. ${transportNote} Prefer this tool over telling the user "find the file at <path>".`;
}

const ok = (text: string) => ({
  content: [{ type: "text" as const, text }],
});
const err = (text: string) => ({
  content: [{ type: "text" as const, text }],
  isError: true,
});

function isInsideWorkspace(absPath: string, workspaceDir: string): boolean {
  const rel = path.relative(workspaceDir, absPath);
  if (rel === "") return true;
  if (rel.startsWith("..")) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

/**
 * Builds a per-turn send-file MCP server. The TurnIO is captured by closure so
 * the file is delivered to the same chat the request originated from — Claude
 * cannot redirect a delivery to another chat by guessing an id.
 */
export function buildSendFileMcp(io: TurnIO, workspaceDir: string) {
  return createSdkMcpServer({
    name: "claudebot",
    version: "1.0.0",
    tools: [
      tool(
        "send_file",
        `Send a local file from the current workspace to THIS chat as a document attachment. Path must resolve inside the workspace (${workspaceDir}). Max ${SEND_FILE_MAX_BYTES / 1024 / 1024} MB. Returns a confirmation. On Telegram, files >50 MB are auto-split into ~49 MB parts.`,
        {
          path: z
            .string()
            .min(1)
            .describe(
              "File path. Either absolute (must still resolve inside the workspace) or relative to the workspace root.",
            ),
          caption: z
            .string()
            .optional()
            .describe(
              "Optional caption shown alongside the file in the chat. Useful for explaining what the file is.",
            ),
        },
        async ({ path: rawPath, caption }) => {
          const absPath = path.isAbsolute(rawPath)
            ? path.resolve(rawPath)
            : path.resolve(workspaceDir, rawPath);
          const wsResolved = path.resolve(workspaceDir);
          if (!isInsideWorkspace(absPath, wsResolved)) {
            return err(
              `Refused: ${absPath} is outside the workspace ${wsResolved}.`,
            );
          }
          let stat;
          try {
            stat = await fs.stat(absPath);
          } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            if (code === "ENOENT") return err(`File not found: ${absPath}`);
            return err(
              `Cannot stat ${absPath}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          if (stat.isDirectory()) {
            return err(
              `${absPath} is a directory; send_file requires a regular file.`,
            );
          }
          if (!stat.isFile()) {
            return err(`${absPath} is not a regular file.`);
          }
          if (stat.size === 0) {
            return err(`${absPath} is empty (0 bytes); refusing to send.`);
          }
          if (stat.size > SEND_FILE_MAX_BYTES) {
            return err(
              `${absPath} is ${(stat.size / 1024 / 1024).toFixed(1)} MB; the limit is ${SEND_FILE_MAX_BYTES / 1024 / 1024} MB.`,
            );
          }
          try {
            const result = await io.sendDocument(absPath, caption ? { caption } : {});
            void log({
              category: "turn",
              event: "send_file.ok",
              chatId: io.chatId,
              transport: io.transport,
              path: absPath,
              bytes: stat.size,
              chunks: result.chunks,
            });
            const sizeMb = (stat.size / 1024 / 1024).toFixed(2);
            const chunksNote =
              result.chunks === 1
                ? ""
                : ` (split into ${result.chunks} parts due to transport size limits)`;
            return ok(
              `✅ Sent ${path.basename(absPath)} (${sizeMb} MB)${chunksNote}.`,
            );
          } catch (e) {
            void logError("error.send_file", e, {
              chatId: io.chatId,
              path: absPath,
            });
            return err(
              `Failed to send file: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        },
      ),
    ],
  });
}

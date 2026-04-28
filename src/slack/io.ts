import type { WebClient, Block, KnownBlock } from "@slack/web-api";
import type {
  ButtonGrid,
  ChatKind,
  ReplyOptions,
  TurnIO,
} from "../handlers/turnIO.ts";
import { toSlackMrkdwn } from "./format.ts";

const SLACK_TEXT_HARD_CAP = 3500;

type SlackBlock = Block | KnownBlock;

function buttonsBlocks(buttons: ButtonGrid): SlackBlock[] {
  // Each row of our ButtonGrid maps to one Slack `actions` block. Slack caps
  // 25 elements per actions block; we never approach that.
  return buttons.map((row) => ({
    type: "actions",
    elements: row.map((b) => ({
      type: "button",
      text: { type: "plain_text", text: b.label, emoji: true },
      // Both `value` and `action_id` carry the callback id. `action_id` is
      // what `app.action` matches on; `value` is what we read in the handler.
      action_id: b.callbackId,
      value: b.callbackId,
    })),
  }));
}

function buildBlocks(text: string, opts?: ReplyOptions): SlackBlock[] {
  const blocks: SlackBlock[] = [];
  if (text.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text },
    });
  }
  if (opts?.buttons && opts.buttons.length > 0) {
    blocks.push(...buttonsBlocks(opts.buttons));
  }
  return blocks;
}

function renderText(text: string, opts?: ReplyOptions): string {
  const sliced = text.slice(0, SLACK_TEXT_HARD_CAP);
  return opts?.parseMode === "markdown" ? toSlackMrkdwn(sliced) : sliced;
}

export function ioFromSlack(
  client: WebClient,
  channelId: string,
  chatKind: ChatKind,
  threadTs?: string,
): TurnIO {
  return {
    chatId: channelId,
    chatKind,
    transport: "slack",
    async reply(text, opts) {
      const formatted = renderText(text, opts);
      const blocks = buildBlocks(formatted, opts);
      const result = await client.chat.postMessage({
        channel: channelId,
        text: formatted,
        ...(blocks.length > 0 ? { blocks } : {}),
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      const ts = result.ts;
      if (typeof ts !== "string") {
        throw new Error("Slack chat.postMessage returned no ts");
      }
      return { messageId: ts };
    },
    async editMessage(messageId, text, opts) {
      const formatted = renderText(text, opts);
      const blocks = buildBlocks(formatted, opts);
      try {
        await client.chat.update({
          channel: channelId,
          ts: messageId,
          text: formatted,
          // An empty blocks array clears any previous blocks (e.g. action
          // buttons) while leaving the text-only fallback as the message body.
          blocks,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Slack does not have a "message is not modified" error like Telegram —
        // chat.update succeeds on no-op edits — so any throw here is a real
        // failure. Surface it.
        throw new Error(`Slack chat.update failed: ${msg}`);
      }
    },
    async removeButtons(messageId) {
      // Slack has no "edit reply markup only" call. Best effort: rewrite the
      // message with no blocks. The text fallback is kept as a single space
      // so the message doesn't disappear visually.
      try {
        await client.chat.update({
          channel: channelId,
          ts: messageId,
          text: " ",
          blocks: [],
        });
      } catch {
        // ignore
      }
    },
    async sendChatAction() {
      // Slack has no public typing-indicator API for bot users. No-op.
    },
    // No sendVoice / sendAudio: Slack TTS support is intentionally deferred.
    // bot.ts checks for the optional methods before calling, so we omit them.
  };
}

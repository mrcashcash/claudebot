import type { App } from "@slack/bolt";
import {
  dispatchApprovalClick,
  dispatchQuestionClick,
} from "../handlers/clickRouter.ts";
import { ioFromSlack } from "./io.ts";

/**
 * Wire Slack interactive payloads (block_actions) for the two callback id
 * families the gateway emits: `q:*` (AskUserQuestion answers) and `perm:*`
 * (tool-approval Allow/Always/Deny/Never). Both are handled by the shared
 * click router in `handlers/clickRouter.ts`.
 */
export function registerSlackActions(app: App): void {
  // The action_id we set on the buttons IS the callback id, so the regex
  // matches every payload we send and lets us route by prefix below.
  app.action(/^(?:perm|q):/, async ({ ack, body, action, client }) => {
    await ack();
    const a = action as { value?: string; action_id?: string };
    const data = (a.value ?? a.action_id ?? "") as string;
    const channelId =
      ("channel" in body && (body as { channel?: { id?: string } }).channel?.id) ||
      "";
    const messageTs =
      ("message" in body && (body as { message?: { ts?: string } }).message?.ts) ||
      "";
    if (!channelId || !messageTs) return;

    const userId =
      ("user" in body && (body as { user?: { id?: string } }).user?.id) ||
      undefined;
    const originalText =
      ("message" in body &&
        ((body as { message?: { text?: string } }).message?.text ?? "")) ||
      "";

    // chatKind is best-effort here: D… = DM, else group. The router only uses
    // io.transport / io.chatId for logging — chatKind doesn't affect routing.
    const chatKind = channelId.startsWith("D") ? "dm" : "group";
    const threadTs =
      ("message" in body &&
        (body as { message?: { thread_ts?: string } }).message?.thread_ts) ||
      undefined;
    const io = ioFromSlack(client, channelId, chatKind, threadTs);
    const clickCtx = { io, messageId: messageTs, originalText, userId };

    if (data.startsWith("q:")) {
      await dispatchQuestionClick(data, clickCtx);
      return;
    }
    if (data.startsWith("perm:")) {
      await dispatchApprovalClick(data, clickCtx);
      return;
    }
  });
}

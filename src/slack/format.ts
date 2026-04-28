/**
 * Convert the gateway's internal "markdown" parse mode (a Telegram-flavoured
 * Markdown subset) to Slack's `mrkdwn` flavour.
 *
 * Conventions in the gateway:
 *   *bold*       → Slack: same syntax (no change)
 *   _italic_     → Slack: same syntax (no change)
 *   `code`       → Slack: same syntax (no change)
 *   ```block```  → Slack: same syntax (no change)
 *   [text](url)  → Slack: <url|text>
 *
 * The gateway-internal text rarely uses Markdown links (most reply text from
 * Claude is plain prose + code blocks), so the rest of the conversion is a
 * pass-through. If a future caller relies on richer formatting, extend here.
 */
export function toSlackMrkdwn(text: string): string {
  return text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");
}

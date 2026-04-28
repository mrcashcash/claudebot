/**
 * Group/channel respond-mode enum, shared by both transports' respond gates.
 *
 * - "always": respond to every message (default).
 * - "mention": respond only when the bot is @-mentioned (or the message is a
 *   reply to a bot message).
 * - "reply": respond only when someone explicitly replies to a bot message.
 *
 * DMs always respond and ignore this — see each transport's respondGate impl.
 */
export type RespondMode = "always" | "mention" | "reply";

export const VALID_RESPOND_MODES: ReadonlySet<RespondMode> = new Set([
  "always",
  "mention",
  "reply",
]);

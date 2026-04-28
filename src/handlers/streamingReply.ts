import type { TurnIO } from "./turnIO.ts";

const STREAM_HARD_CAP = 4000;
const STREAM_HEAD_LIMIT = 4000;
const STREAM_DEBOUNCE_MS = 700;

/**
 * Live-streams Claude's reply into a single transport message by editing it as
 * text accumulates. The placeholder is created lazily on the first push so
 * turns that never produce text (tool-only) don't leave an empty message.
 *
 * The TurnIO abstraction handles "message is not modified" silently, so this
 * module doesn't need to know the underlying transport's quirks.
 */
export interface StreamingReply {
  /** Update the live preview with the current accumulated text. */
  push(fullText: string): void;
  /** Replace the placeholder with the final body (chunked if needed). */
  finalize(parts: string[]): Promise<void>;
  /** Edit the placeholder with the given text — used on error/abort. */
  fail(text: string): Promise<void>;
  /** Whether a placeholder was sent (any text streamed). */
  hasPlaceholder(): boolean;
}

export function createStreamingReply(io: TurnIO): StreamingReply {
  let placeholderId: string | undefined;
  let pendingText = "";
  let lastShownText = "";
  let editScheduled: NodeJS.Timeout | null = null;
  let editInFlight = false;
  let lastEditAt = 0;
  let creating: Promise<void> | null = null;
  // One-shot give-up: if the placeholder send fails (chat blocked, rate limit,
  // bot kicked from group, …) further pushes mustn't keep retrying — Claude
  // streams text every few hundred ms and we'd flood the transport with
  // failing sends. finalize() still does its own send in the no-placeholder
  // branch.
  let placeholderFailed = false;

  async function ensurePlaceholder(): Promise<void> {
    if (placeholderId !== undefined) return;
    if (placeholderFailed) return;
    if (creating) {
      await creating;
      return;
    }
    creating = (async () => {
      try {
        const sent = await io.reply("…");
        placeholderId = sent.messageId;
      } catch (err) {
        placeholderFailed = true;
        console.warn(
          "[stream] placeholder send failed (giving up for this turn):",
          err instanceof Error ? err.message : String(err),
        );
      } finally {
        creating = null;
      }
    })();
    await creating;
  }

  async function flushEdit(): Promise<void> {
    if (placeholderId === undefined) return;
    if (editInFlight) return;
    if (pendingText === lastShownText) return;
    editInFlight = true;
    const snapshot = pendingText;
    const text =
      snapshot.length > STREAM_HEAD_LIMIT
        ? snapshot.slice(0, STREAM_HEAD_LIMIT) + "\n\n…"
        : snapshot;
    try {
      await io.editMessage(placeholderId, text);
      lastShownText = snapshot;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[stream] edit failed:", msg);
    } finally {
      editInFlight = false;
      lastEditAt = Date.now();
    }
  }

  function scheduleEdit(): void {
    if (editScheduled) return;
    const sinceLast = Date.now() - lastEditAt;
    const wait = Math.max(STREAM_DEBOUNCE_MS - sinceLast, 0);
    editScheduled = setTimeout(() => {
      editScheduled = null;
      void flushEdit();
    }, wait);
  }

  function push(fullText: string): void {
    if (fullText.length === 0) return;
    pendingText = fullText;
    void ensurePlaceholder().then(() => scheduleEdit());
  }

  async function settle(): Promise<void> {
    if (editScheduled) {
      clearTimeout(editScheduled);
      editScheduled = null;
    }
    // Wait for any in-flight edit so the final edit isn't racing against it.
    let waited = 0;
    while (editInFlight && waited < 5000) {
      await new Promise((r) => setTimeout(r, 50));
      waited += 50;
    }
  }

  async function finalize(parts: string[]): Promise<void> {
    await settle();
    const first = parts[0] ?? "";
    if (placeholderId !== undefined) {
      try {
        await io.editMessage(placeholderId, first.slice(0, STREAM_HARD_CAP));
      } catch {
        await io.reply(first.slice(0, STREAM_HARD_CAP));
      }
    } else {
      await io.reply(first.slice(0, STREAM_HARD_CAP));
    }
    for (const part of parts.slice(1)) {
      await io.reply(part.slice(0, STREAM_HARD_CAP));
    }
  }

  async function fail(text: string): Promise<void> {
    await settle();
    if (placeholderId !== undefined) {
      try {
        await io.editMessage(placeholderId, text.slice(0, STREAM_HARD_CAP));
        return;
      } catch {
        // fall through to reply
      }
    }
    await io.reply(text.slice(0, STREAM_HARD_CAP));
  }

  function hasPlaceholder(): boolean {
    return placeholderId !== undefined;
  }

  return { push, finalize, fail, hasPlaceholder };
}

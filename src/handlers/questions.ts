import type { ButtonGrid, TurnIO } from "./turnIO.ts";

export interface QuestionOption {
  label: string;
  description: string;
}

export interface QuestionDef {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

interface ActiveSession {
  requestId: string;
  chatId: string;
  questions: QuestionDef[];
  answers: Record<string, string>;
  currentIndex: number;
  toggled: Set<number>;
  messageId: string | undefined;
  io: TurnIO;
  resolve: (answers: Record<string, string>) => void;
  cancelled: boolean;
}

const active = new Map<string, ActiveSession>();

const MAX_LABEL = 30;

function ellipsize(s: string, max = MAX_LABEL): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function buildButtons(s: ActiveSession): ButtonGrid {
  const q = s.questions[s.currentIndex]!;
  const rows: ButtonGrid = q.options.map((opt, idx) => {
    const prefix = q.multiSelect
      ? s.toggled.has(idx)
        ? "✓ "
        : "○ "
      : "";
    return [
      {
        label: prefix + ellipsize(opt.label),
        callbackId: `q:${s.requestId}:${s.currentIndex}:opt:${idx}`,
      },
    ];
  });
  if (q.multiSelect) {
    rows.push([
      {
        label: "✅ Done",
        callbackId: `q:${s.requestId}:${s.currentIndex}:done`,
      },
    ]);
  }
  return rows;
}

function questionText(s: ActiveSession): string {
  const q = s.questions[s.currentIndex]!;
  const lines = [
    `❓ *${q.question}*`,
    `_(${s.currentIndex + 1}/${s.questions.length}` +
      (q.multiSelect ? " — multi-select" : "") +
      ")_",
    "",
    ...q.options.map((o) => `• *${o.label}* — ${o.description}`),
  ];
  return lines.join("\n");
}

async function renderCurrent(s: ActiveSession): Promise<void> {
  const text = questionText(s);
  const buttons = buildButtons(s);
  if (s.messageId !== undefined) {
    await s.io.editMessage(s.messageId, text, {
      parseMode: "markdown",
      buttons,
    });
  } else {
    const sent = await s.io.reply(text, { parseMode: "markdown", buttons });
    s.messageId = sent.messageId;
  }
}

async function finalizeMessage(s: ActiveSession, summary: string): Promise<void> {
  if (s.messageId === undefined) return;
  try {
    await s.io.editMessage(s.messageId, summary, { parseMode: "markdown" });
  } catch {
    await s.io.removeButtons(s.messageId);
  }
}

async function advance(s: ActiveSession, justAnsweredText: string): Promise<void> {
  await finalizeMessage(s, justAnsweredText);
  s.currentIndex += 1;
  s.toggled = new Set();
  s.messageId = undefined;
  if (s.currentIndex >= s.questions.length) {
    active.delete(s.requestId);
    s.resolve({ ...s.answers });
    return;
  }
  await renderCurrent(s);
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export async function ask(
  io: TurnIO,
  _toolUseId: string,
  questions: QuestionDef[],
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    let requestId = shortId();
    while (active.has(requestId)) requestId = shortId();
    const s: ActiveSession = {
      requestId,
      chatId: io.chatId,
      questions,
      answers: {},
      currentIndex: 0,
      toggled: new Set(),
      messageId: undefined,
      io,
      resolve,
      cancelled: false,
    };
    active.set(requestId, s);

    const onAbort = (): void => {
      if (!active.has(requestId)) return;
      active.delete(requestId);
      s.cancelled = true;
      if (s.messageId !== undefined) {
        void s.io
          .editMessage(
            s.messageId,
            "❓ _(question cancelled — turn superseded)_",
            { parseMode: "markdown" },
          )
          .catch(() => {});
      }
      resolve({ ...s.answers });
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    void renderCurrent(s);
  });
}

export interface ClickOutcome {
  ok: boolean;
  toast: string;
}

export async function handleClick(data: string): Promise<ClickOutcome | null> {
  // q:<rid>:<qi>:opt:<oi>  |  q:<rid>:<qi>:done
  const m = /^q:([^:]+):(\d+):(opt:(\d+)|done)$/.exec(data);
  console.log(
    `[q] handleClick data="${data}" matched=${!!m} active.size=${active.size} keys=[${[...active.keys()].join(",")}]`,
  );
  if (!m) return null;
  const [, rid, qiStr, , oiStr] = m;
  const s = active.get(rid!);
  if (!s) return { ok: false, toast: "Question expired." };
  const qi = Number(qiStr);
  if (qi !== s.currentIndex) {
    return { ok: false, toast: "Stale question." };
  }
  const q = s.questions[qi]!;
  if (oiStr !== undefined) {
    const oi = Number(oiStr);
    const opt = q.options[oi];
    if (!opt) return { ok: false, toast: "Unknown option." };
    if (q.multiSelect) {
      if (s.toggled.has(oi)) s.toggled.delete(oi);
      else s.toggled.add(oi);
      await renderCurrent(s);
      return { ok: true, toast: s.toggled.has(oi) ? "Selected" : "Unselected" };
    }
    s.answers[q.question] = opt.label;
    const summary = `❓ *${q.question}*\n\n✅ ${opt.label}`;
    await advance(s, summary);
    return { ok: true, toast: "Answered" };
  }
  // done
  if (!q.multiSelect) return { ok: false, toast: "Not multi-select." };
  if (s.toggled.size === 0) {
    return { ok: false, toast: "Pick at least one." };
  }
  const labels = [...s.toggled]
    .sort((a, b) => a - b)
    .map((i) => q.options[i]!.label);
  s.answers[q.question] = labels.join(", ");
  const summary = `❓ *${q.question}*\n\n✅ ${labels.join(", ")}`;
  await advance(s, summary);
  return { ok: true, toast: "Done" };
}

export function cancelAll(): void {
  for (const [rid, s] of [...active.entries()]) {
    active.delete(rid);
    s.cancelled = true;
    s.resolve({ ...s.answers });
  }
}

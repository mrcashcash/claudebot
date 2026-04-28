import fs from "node:fs/promises";
import path from "node:path";

const FILE = path.join(process.cwd(), "data", "restart-marker.json");

export type Transport = "telegram" | "slack";

export interface RestartChat {
  chatId: string;
  transport: Transport;
}

export interface RestartMarker {
  chats: RestartChat[];
  reason: string;
  shutdownAt: number;
}

export async function write(marker: RestartMarker): Promise<void> {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(marker), "utf8");
}

export async function consume(): Promise<RestartMarker | null> {
  let raw: string;
  try {
    raw = await fs.readFile(FILE, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  await fs.unlink(FILE).catch(() => {});
  try {
    const parsed = JSON.parse(raw) as Partial<RestartMarker> & {
      chats?: unknown;
    };
    if (!Array.isArray(parsed.chats)) return null;
    // Migration: legacy markers stored chats as number[] (Telegram-only).
    const chats: RestartChat[] = parsed.chats.map((entry) => {
      if (typeof entry === "number" || typeof entry === "string") {
        return { chatId: String(entry), transport: "telegram" as const };
      }
      const o = entry as { chatId?: unknown; transport?: unknown };
      const chatId =
        typeof o.chatId === "number" || typeof o.chatId === "string"
          ? String(o.chatId)
          : "";
      const transport =
        o.transport === "slack" ? "slack" : ("telegram" as Transport);
      return { chatId, transport };
    });
    return {
      chats: chats.filter((c) => c.chatId.length > 0),
      reason: typeof parsed.reason === "string" ? parsed.reason : "unknown",
      shutdownAt:
        typeof parsed.shutdownAt === "number" ? parsed.shutdownAt : 0,
    };
  } catch {
    return null;
  }
}

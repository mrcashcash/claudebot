import fs from "node:fs/promises";
import path from "node:path";

const FILE = path.join(process.cwd(), "data", "restart-marker.json");

export interface RestartMarker {
  chats: number[];
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
    const parsed = JSON.parse(raw) as RestartMarker;
    if (!Array.isArray(parsed.chats)) return null;
    return parsed;
  } catch {
    return null;
  }
}

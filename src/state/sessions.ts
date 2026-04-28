import * as store from "./store.ts";
import type { ChatState } from "./store.ts";

export type { ChatState };

let loaded = false;

/**
 * No-op assertion — the heavy lifting happens in `store.load()`, which must
 * already have been awaited by the bootstrap. This stays exported so
 * `index.ts` can keep its current load-order shape (`store.load()` →
 * `sessions.load()` → `users.load()`).
 */
export async function load(): Promise<void> {
  loaded = true;
}

function assertLoaded(): void {
  if (!loaded) throw new Error("sessions.load() must be called before use");
}

export function get(chatId: number | string): ChatState {
  assertLoaded();
  return store.getSessions()[String(chatId)] ?? {};
}

export async function update(
  chatId: number | string,
  patch: Partial<ChatState>,
): Promise<void> {
  assertLoaded();
  const sessions = store.getSessions();
  const key = String(chatId);
  sessions[key] = { ...(sessions[key] ?? {}), ...patch };
  await store.persist();
}

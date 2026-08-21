import type { TurnIO } from "../handlers/turnIO.ts";
import type { Transport } from "../state/crons.ts";

/**
 * Per-transport factory for a *durable* TurnIO — one that isn't bound to the
 * update/event that triggered it. Background tasks (core/taskRunner.ts) outlive
 * the handler that started them, so they can't hold a Telegraf `ctx`-derived
 * io; they look one up here instead.
 *
 * Same shape and rationale as `scheduler/transport.ts`: each transport
 * registers itself at startup, and core/ stays free of Telegraf and Bolt.
 */
export type IoFactory = (
  chatId: string,
  chatKind: "dm" | "group",
) => TurnIO | undefined;

const registry = new Map<Transport, IoFactory>();

export function registerIoFactory(name: Transport, fn: IoFactory): void {
  registry.set(name, fn);
}

export function ioFor(
  transport: Transport,
  chatId: string,
  chatKind: "dm" | "group",
): TurnIO | undefined {
  return registry.get(transport)?.(chatId, chatKind);
}

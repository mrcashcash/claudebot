import type { Transport } from "../state/crons.ts";

/**
 * Per-transport `kickOffTurnFromCron` implementation. Each transport
 * registers itself at startup so the scheduler ticker can dispatch a fired
 * cron back to the right transport without knowing about Telegraf or
 * Slack Bolt directly.
 */
export type CronKickOff = (
  chatId: string,
  userId: number | string,
  prompt: string,
  opts: { triggerSource: "cron"; persistSession?: boolean },
) => void;

const registry = new Map<Transport, CronKickOff>();

export function registerTransport(name: Transport, fn: CronKickOff): void {
  registry.set(name, fn);
}

export function getTransportKickOff(
  name: Transport,
): CronKickOff | undefined {
  return registry.get(name);
}

export function transportNames(): Transport[] {
  return [...registry.keys()];
}

/**
 * Per-transport notify implementation, used by system-task crons that post
 * a result message directly without going through the Claude turn pipeline.
 */
export type Notify = (chatId: string, text: string) => Promise<void>;

const notifyRegistry = new Map<Transport, Notify>();

export function registerNotify(name: Transport, fn: Notify): void {
  notifyRegistry.set(name, fn);
}

export function getNotify(name: Transport): Notify | undefined {
  return notifyRegistry.get(name);
}

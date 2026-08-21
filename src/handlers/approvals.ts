export type Decision = "allow" | "deny";
/**
 * "once"    — this call only.
 * "always"  — bare-tool rule (any input), i.e. the historical meaning.
 * "pattern" — scoped rule; the pattern is recomputed by the resolver from the
 *             pending call's input rather than carried in the callback id,
 *             which has to fit in Telegram's 64-byte callback_data.
 */
export type Scope = "once" | "always" | "pattern";

export interface ApprovalChoice {
  decision: Decision;
  scope: Scope;
}

type Resolver = (choice: ApprovalChoice) => void;

const pending = new Map<string, Resolver>();

export function register(toolUseId: string, resolver: Resolver): void {
  pending.set(toolUseId, resolver);
}

export function unregister(toolUseId: string): void {
  pending.delete(toolUseId);
}

export function settle(toolUseId: string, choice: ApprovalChoice): boolean {
  const resolver = pending.get(toolUseId);
  if (!resolver) return false;
  pending.delete(toolUseId);
  resolver(choice);
  return true;
}

export function isPending(toolUseId: string): boolean {
  return pending.has(toolUseId);
}

export function denyAll(): void {
  const entries = [...pending.entries()];
  pending.clear();
  for (const [, resolver] of entries) {
    resolver({ decision: "deny", scope: "once" });
  }
}

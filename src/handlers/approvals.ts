export type Decision = "allow" | "deny";
export type Scope = "once" | "always";

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

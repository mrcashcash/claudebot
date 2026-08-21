import crypto from "node:crypto";
import * as store from "./store.ts";
import type { ChatState, TrustGrant, TrustRule } from "./store.ts";

export type { ChatState, TrustGrant, TrustRule };

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

/** The chat's effective trust rules, legacy arrays folded in. */
export function trustRulesFor(chatId: number | string): TrustRule[] {
  assertLoaded();
  return store.deriveTrustRules(get(chatId));
}

/**
 * Append a trust rule, migrating the legacy `allowAlwaysTools` /
 * `denyAlwaysTools` arrays into `trustRules` in the same write. Read-and-merge
 * is synchronous (no awaits before the write) so two concurrent "Always"
 * clicks can't clobber each other. Idempotent on an identical rule.
 */
export async function addTrustRule(
  chatId: number | string,
  effect: "allow" | "deny",
  tool: string,
  arg?: string,
): Promise<TrustRule> {
  assertLoaded();
  const sessions = store.getSessions();
  const key = String(chatId);
  const current = sessions[key] ?? {};
  const migrated = store.deriveTrustRules(current).map((r) =>
    r.createdAt === 0 ? { ...r, id: freshRuleId(), createdAt: Date.now() } : r,
  );
  const existing = migrated.find(
    (r) => r.effect === effect && r.tool === tool && (r.arg ?? "") === (arg ?? ""),
  );
  const rule: TrustRule =
    existing ??
    ({
      id: freshRuleId(),
      effect,
      tool,
      ...(arg ? { arg } : {}),
      createdAt: Date.now(),
    } satisfies TrustRule);
  const next = existing ? migrated : [...migrated, rule];
  sessions[key] = {
    ...current,
    trustRules: next,
    allowAlwaysTools: undefined,
    denyAlwaysTools: undefined,
  };
  await store.persist();
  return rule;
}

/** Remove one rule by 1-based display index. Returns the removed rule. */
export async function removeTrustRuleAt(
  chatId: number | string,
  index1: number,
): Promise<TrustRule | undefined> {
  assertLoaded();
  const sessions = store.getSessions();
  const key = String(chatId);
  const current = sessions[key] ?? {};
  const migrated = store.deriveTrustRules(current).map((r) =>
    r.createdAt === 0 ? { ...r, id: freshRuleId(), createdAt: Date.now() } : r,
  );
  const idx = index1 - 1;
  if (idx < 0 || idx >= migrated.length) return undefined;
  const [removed] = migrated.splice(idx, 1);
  sessions[key] = {
    ...current,
    trustRules: migrated,
    allowAlwaysTools: undefined,
    denyAlwaysTools: undefined,
  };
  await store.persist();
  return removed;
}

export async function clearTrust(chatId: number | string): Promise<void> {
  assertLoaded();
  await update(chatId, {
    trustRules: [],
    allowAlwaysTools: undefined,
    denyAlwaysTools: undefined,
    grants: [],
  });
}

/** Add a time-boxed grant, dropping any already-expired ones. */
export async function addGrant(
  chatId: number | string,
  grant: Omit<TrustGrant, "createdAt">,
): Promise<void> {
  assertLoaded();
  const sessions = store.getSessions();
  const key = String(chatId);
  const current = sessions[key] ?? {};
  const now = Date.now();
  const live = (current.grants ?? []).filter((g) => g.untilMs > now);
  sessions[key] = {
    ...current,
    grants: [...live, { ...grant, createdAt: now }],
  };
  await store.persist();
}

export async function clearGrants(chatId: number | string): Promise<void> {
  assertLoaded();
  await update(chatId, { grants: [] });
}

function freshRuleId(): string {
  return crypto.randomBytes(6).toString("base64url").slice(0, 8);
}

// `addAlwaysRule` used to append to allowAlwaysTools / denyAlwaysTools here.
// `addTrustRule` above replaced it: the "Always" button now writes a TrustRule
// and migrates the legacy arrays in the same write. The old fields are still
// *read* (via store.deriveTrustRules) so existing chats keep working.

import path from "node:path";
import type { TrustGrant, TrustRule } from "../state/store.ts";

/**
 * Trust policy: which tool calls run without asking.
 *
 * A rule is `Tool` or `Tool(arg-pattern)`. The bare form matches any input —
 * exactly what the legacy `allowAlwaysTools` / `denyAlwaysTools` entries meant,
 * which is what lets them migrate 1:1. The parenthesised form globs against
 * ONE canonical string per tool, defined by CANON below.
 *
 * CANON is the security boundary of this whole feature. If a tool's canonical
 * string doesn't capture the part of the input that matters, a rule that looks
 * narrow is actually wide. Adding a tool here deserves more thought than the
 * line count suggests; anything unlisted falls back to `json` mode, which
 * matches against the serialized input and is therefore hard to write a
 * dangerously-loose pattern for by accident.
 *
 * Evaluation order is deny → allow → grant → prompt. Deny always wins, so a
 * standing `deny Bash(git push *)` can't be defeated by a later allow or by an
 * active grant.
 */

export type Verdict = "allow" | "deny" | "prompt";

/** How a tool's canonical string is derived, and how patterns match it. */
type CanonMode = "command" | "path" | "host" | "json";

interface CanonSpec {
  mode: CanonMode;
  /** Input field to read. */
  field?: string;
}

const CANON: Record<string, CanonSpec> = {
  Bash: { mode: "command", field: "command" },
  PowerShell: { mode: "command", field: "command" },
  Read: { mode: "path", field: "file_path" },
  Write: { mode: "path", field: "file_path" },
  Edit: { mode: "path", field: "file_path" },
  MultiEdit: { mode: "path", field: "file_path" },
  NotebookEdit: { mode: "path", field: "notebook_path" },
  Glob: { mode: "command", field: "pattern" },
  Grep: { mode: "command", field: "pattern" },
  WebFetch: { mode: "host", field: "url" },
  WebSearch: { mode: "command", field: "query" },
};

function specFor(toolName: string): CanonSpec {
  return CANON[toolName] ?? { mode: "json" };
}

/**
 * Reduce a tool call to the single string its rules match against. Returns
 * undefined when the expected field is missing, which forces a prompt rather
 * than risking a match against the wrong thing.
 */
export function canonicalArg(
  toolName: string,
  input: Record<string, unknown>,
  workspaceDir?: string,
): string | undefined {
  const spec = specFor(toolName);
  if (spec.mode === "json") {
    try {
      return JSON.stringify(input);
    } catch {
      return undefined;
    }
  }
  const raw = spec.field ? input[spec.field] : undefined;
  if (typeof raw !== "string" || raw.length === 0) return undefined;

  if (spec.mode === "command") return raw.replace(/\s+/g, " ").trim();

  if (spec.mode === "host") {
    try {
      return new URL(raw).host.toLowerCase();
    } catch {
      return undefined;
    }
  }

  // path: workspace-relative, forward slashes. An absolute path outside the
  // workspace stays absolute so a `src/**` rule can never match it.
  const abs = path.resolve(workspaceDir ?? process.cwd(), raw);
  if (workspaceDir) {
    const rel = path.relative(path.resolve(workspaceDir), abs);
    if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      return rel.split(path.sep).join("/");
    }
  }
  return abs.split(path.sep).join("/");
}

/**
 * Glob → RegExp. In `path` mode `*` stops at a separator and `**` crosses it,
 * which is what makes `src/*` and `src/**` mean different things. Everywhere
 * else `*` is a plain wildcard, so `npm *` covers `npm run dev --watch`.
 */
function globToRegExp(pattern: string, mode: CanonMode): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === "*") {
      const isDouble = pattern[i + 1] === "*";
      if (isDouble) {
        out += ".*";
        i += 1;
        // Swallow a following slash so `src/**/x` also matches `src/x`.
        if (mode === "path" && pattern[i + 1] === "/") i += 1;
      } else {
        out += mode === "path" ? "[^/]*" : ".*";
      }
      continue;
    }
    if (ch === "?") {
      out += mode === "path" ? "[^/]" : ".";
      continue;
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, mode === "path" ? "" : "i");
}

/** `/etc/x` or `C:/Users/x` — i.e. not workspace-relative. */
function isAbsoluteish(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:\//.test(p);
}

export function argMatches(
  pattern: string,
  value: string,
  mode: CanonMode,
): boolean {
  // A workspace-relative pattern must never match a path outside the
  // workspace: `canonicalArg` leaves those absolute precisely so that a broad
  // rule like `Write(**)` stays scoped to the project. Reaching outside has to
  // be spelled out with an absolute pattern (`Write(C:/tmp/**)`).
  if (mode === "path" && isAbsoluteish(value) !== isAbsoluteish(pattern)) {
    return false;
  }
  try {
    return globToRegExp(pattern, mode).test(value);
  } catch {
    return false;
  }
}

const RULE_RE = /^([A-Za-z_][A-Za-z0-9_]*(?:__[A-Za-z0-9_]+)*)(?:\((.*)\))?$/;

export interface ParsedRule {
  tool: string;
  arg?: string;
}

/**
 * Parse `Bash(npm run *)` / `Write(src/**)` / `Bash`. Returns null on garbage
 * so callers can show usage instead of silently storing a rule that matches
 * nothing.
 */
export function parseRule(text: string): ParsedRule | null {
  const trimmed = text.trim();
  const m = RULE_RE.exec(trimmed);
  if (!m) return null;
  const tool = m[1]!;
  const arg = m[2];
  if (arg === undefined) return { tool };
  const inner = arg.trim();
  if (inner.length === 0) return { tool };
  return { tool, arg: inner };
}

export function formatRule(rule: TrustRule): string {
  return rule.arg ? `${rule.tool}(${rule.arg})` : rule.tool;
}

export function activeGrant(
  grants: TrustGrant[] | undefined,
  opts: { taskId?: string; now?: number },
): TrustGrant | undefined {
  const now = opts.now ?? Date.now();
  return (grants ?? []).find((g) => {
    if (g.untilMs <= now) return false;
    if (g.scope === "chat") return true;
    return opts.taskId !== undefined && g.taskId === opts.taskId;
  });
}

export interface EvaluateArgs {
  toolName: string;
  input: Record<string, unknown>;
  rules: TrustRule[];
  grants?: TrustGrant[];
  workspaceDir?: string;
  /** Set for task turns, so task-scoped grants apply. */
  taskId?: string;
  now?: number;
}

export interface EvaluateResult {
  verdict: Verdict;
  /** The rule or grant that decided it, for logging and for the click toast. */
  reason: string;
}

export function evaluate(args: EvaluateArgs): EvaluateResult {
  const { toolName, input, rules, grants, workspaceDir, taskId, now } = args;
  const mode = specFor(toolName).mode;
  const canon = canonicalArg(toolName, input, workspaceDir);

  const matching = (effect: "allow" | "deny"): TrustRule | undefined =>
    rules.find((r) => {
      if (r.effect !== effect || r.tool !== toolName) return false;
      if (!r.arg) return true;
      if (canon === undefined) return false;
      return argMatches(r.arg, canon, mode);
    });

  const denyRule = matching("deny");
  if (denyRule) {
    return { verdict: "deny", reason: `rule ${formatRule(denyRule)}` };
  }
  const allowRule = matching("allow");
  if (allowRule) {
    return { verdict: "allow", reason: `rule ${formatRule(allowRule)}` };
  }
  const grant = activeGrant(grants, {
    ...(taskId !== undefined ? { taskId } : {}),
    ...(now !== undefined ? { now } : {}),
  });
  if (grant) {
    const mins = Math.max(1, Math.round((grant.untilMs - (now ?? Date.now())) / 60_000));
    return { verdict: "allow", reason: `grant (${mins}m left)` };
  }
  return { verdict: "prompt", reason: "no matching rule" };
}

/**
 * The pattern offered on the "Always …" button — the narrowest generalization
 * that is still likely to be reusable. Open question 4 in the design doc is
 * settled this way on purpose: the button never widens beyond this, and
 * anything broader has to be typed explicitly via `/trust allow`.
 *
 * Bash/PowerShell → first two words for a `<tool> <subcommand>` shape
 * (`npm run *`, `git status *`), else the first word (`ls *`).
 * Path tools → the file's directory (`src/handlers/*`).
 * WebFetch → the host.
 */
export function proposePattern(
  toolName: string,
  input: Record<string, unknown>,
  workspaceDir?: string,
): string | undefined {
  const spec = specFor(toolName);
  const canon = canonicalArg(toolName, input, workspaceDir);
  if (!canon) return undefined;

  if (spec.mode === "command") {
    const words = canon.split(" ").filter(Boolean);
    if (words.length === 0) return undefined;
    const first = words[0]!;
    const second = words[1];
    // A second word that looks like a subcommand (not a flag or a path) makes
    // a much more useful rule than the bare binary name.
    if (second && /^[a-z][a-z0-9:_-]*$/i.test(second) && !second.includes("/")) {
      return `${first} ${second} *`;
    }
    return `${first} *`;
  }
  if (spec.mode === "host") return canon;
  if (spec.mode === "path") {
    const dir = canon.includes("/") ? canon.slice(0, canon.lastIndexOf("/")) : "";
    return dir ? `${dir}/*` : "*";
  }
  return undefined;
}

export function formatRuleTable(rules: TrustRule[]): string {
  if (rules.length === 0) return "_No trust rules._";
  const lines: string[] = [];
  for (const [i, r] of rules.entries()) {
    const mark = r.effect === "allow" ? "✅" : "⛔";
    const legacy = r.createdAt === 0 ? " _(legacy)_" : "";
    lines.push(`${i + 1}. ${mark} \`${formatRule(r)}\`${legacy}`);
  }
  return lines.join("\n");
}

/** Parse "30m" / "2h" / "45" (minutes) into ms. Capped at 24h. */
export function parseDuration(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes|h|hr|hrs|hours)?$/i.exec(
    text.trim(),
  );
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] ?? "m").toLowerCase();
  const ms = unit.startsWith("h") ? n * 3_600_000 : n * 60_000;
  return Math.min(ms, 24 * 3_600_000);
}

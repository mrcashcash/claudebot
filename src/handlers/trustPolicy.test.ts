import test from "node:test";
import assert from "node:assert/strict";
import { deriveTrustRules } from "../state/store.ts";
import type { TrustRule } from "../state/store.ts";
import {
  canonicalArg,
  evaluate,
  parseDuration,
  parseRule,
  proposePattern,
} from "./trustPolicy.ts";

/**
 * The matcher is the security boundary of the trust feature: a pattern that
 * looks narrow but matches wide is a privilege-escalation bug, so the
 * semantics get pinned here. Run with `npm test`.
 */

const WS = process.platform === "win32" ? "D:\\repo" : "/repo";
let seq = 0;
const rule = (
  effect: "allow" | "deny",
  tool: string,
  arg?: string,
): TrustRule => ({
  id: `r${(seq += 1)}`,
  effect,
  tool,
  ...(arg ? { arg } : {}),
  createdAt: 1,
});

const verdict = (
  rules: TrustRule[],
  tool: string,
  input: Record<string, unknown>,
  extra: { grants?: never[]; now?: number } = {},
) =>
  evaluate({ toolName: tool, input, rules, workspaceDir: WS, ...extra }).verdict;

test("bare rule matches any input (legacy semantics)", () => {
  const rules = [rule("allow", "Bash")];
  assert.equal(verdict(rules, "Bash", { command: "rm -rf /" }), "allow");
  assert.equal(verdict(rules, "Write", { file_path: "a.ts" }), "prompt");
});

test("command patterns match on a normalized command string", () => {
  const rules = [rule("allow", "Bash", "npm run *")];
  assert.equal(verdict(rules, "Bash", { command: "npm run dev" }), "allow");
  assert.equal(verdict(rules, "Bash", { command: "npm  run   dev --watch" }), "allow");
  assert.equal(verdict(rules, "Bash", { command: "npm publish" }), "prompt");
  // No sneaking a second command past the pattern's anchor.
  assert.equal(verdict(rules, "Bash", { command: "sudo npm run dev" }), "prompt");
});

test("deny beats allow and beats an active grant", () => {
  const rules = [rule("allow", "Bash"), rule("deny", "Bash", "git push *")];
  assert.equal(verdict(rules, "Bash", { command: "git push origin main" }), "deny");
  const withGrant = evaluate({
    toolName: "Bash",
    input: { command: "git push origin main" },
    rules: [rule("deny", "Bash", "git push *")],
    grants: [{ untilMs: Date.now() + 60_000, scope: "chat", createdAt: 0 }],
    workspaceDir: WS,
  });
  assert.equal(withGrant.verdict, "deny");
});

test("path patterns: * stops at a separator, ** crosses it", () => {
  const shallow = [rule("allow", "Write", "src/*")];
  const deep = [rule("allow", "Write", "src/**")];
  const nested = { file_path: "src/handlers/x.ts" };
  const top = { file_path: "src/index.ts" };
  assert.equal(verdict(shallow, "Write", top), "allow");
  assert.equal(verdict(shallow, "Write", nested), "prompt");
  assert.equal(verdict(deep, "Write", nested), "allow");
  assert.equal(verdict(deep, "Write", top), "allow");
});

test("paths outside the workspace never match a relative rule", () => {
  const rules = [rule("allow", "Write", "**")];
  const outside =
    process.platform === "win32" ? "C:\\Windows\\evil.txt" : "/etc/evil.txt";
  assert.equal(verdict(rules, "Write", { file_path: outside }), "prompt");
  // ...and neither does an escape attempt via traversal.
  assert.equal(
    verdict(rules, "Write", { file_path: "../../etc/passwd" }),
    "prompt",
  );
  // Reaching outside has to be explicit, via an absolute pattern.
  const absPattern = process.platform === "win32" ? "C:/Windows/**" : "/etc/**";
  assert.equal(
    verdict([rule("allow", "Write", absPattern)], "Write", { file_path: outside }),
    "allow",
  );
  // An absolute rule must not double as a relative one.
  assert.equal(
    verdict([rule("allow", "Write", absPattern)], "Write", {
      file_path: "src/index.ts",
    }),
    "prompt",
  );
});

test("glob metacharacters in a rule are matched literally", () => {
  const rules = [rule("allow", "Bash", "echo a.b")];
  assert.equal(verdict(rules, "Bash", { command: "echo a.b" }), "allow");
  assert.equal(verdict(rules, "Bash", { command: "echo axb" }), "prompt");
});

test("WebFetch rules match the host, not the whole URL", () => {
  const rules = [rule("allow", "WebFetch", "api.github.com")];
  assert.equal(
    verdict(rules, "WebFetch", { url: "https://api.github.com/repos/x/y" }),
    "allow",
  );
  assert.equal(
    verdict(rules, "WebFetch", { url: "https://evil.com/api.github.com" }),
    "prompt",
  );
});

test("a missing canonical field forces a prompt rather than a loose match", () => {
  const rules = [rule("allow", "Bash", "*")];
  assert.equal(verdict(rules, "Bash", {}), "prompt");
  assert.equal(canonicalArg("Bash", {}), undefined);
});

test("unknown tools fall back to matching serialized input", () => {
  const rules = [rule("allow", "mcp__foo__bar", '*"safe":true*')];
  assert.equal(verdict(rules, "mcp__foo__bar", { safe: true }), "allow");
  assert.equal(verdict(rules, "mcp__foo__bar", { safe: false }), "prompt");
});

test("grants expire on wall clock", () => {
  const now = 1_000_000;
  const args = {
    toolName: "Bash",
    input: { command: "ls" },
    rules: [] as TrustRule[],
    workspaceDir: WS,
  };
  assert.equal(
    evaluate({
      ...args,
      grants: [{ untilMs: now + 1, scope: "chat", createdAt: 0 }],
      now,
    }).verdict,
    "allow",
  );
  assert.equal(
    evaluate({
      ...args,
      grants: [{ untilMs: now, scope: "chat", createdAt: 0 }],
      now,
    }).verdict,
    "prompt",
  );
});

test("task-scoped grants don't leak to other tasks", () => {
  const grants = [
    { untilMs: Date.now() + 60_000, scope: "task" as const, taskId: "t1", createdAt: 0 },
  ];
  const base = {
    toolName: "Bash",
    input: { command: "ls" },
    rules: [] as TrustRule[],
    grants,
    workspaceDir: WS,
  };
  assert.equal(evaluate({ ...base, taskId: "t1" }).verdict, "allow");
  assert.equal(evaluate({ ...base, taskId: "t2" }).verdict, "prompt");
  assert.equal(evaluate(base).verdict, "prompt");
});

test("parseRule accepts bare, patterned and mcp names; rejects junk", () => {
  assert.deepEqual(parseRule("Bash"), { tool: "Bash" });
  assert.deepEqual(parseRule("Bash(npm run *)"), { tool: "Bash", arg: "npm run *" });
  assert.deepEqual(parseRule("mcp__scheduler__cron_list"), {
    tool: "mcp__scheduler__cron_list",
  });
  assert.deepEqual(parseRule("Bash()"), { tool: "Bash" });
  assert.equal(parseRule("rm -rf /"), null);
  assert.equal(parseRule(""), null);
});

test("proposePattern narrows to a reusable rule", () => {
  assert.equal(proposePattern("Bash", { command: "npm run dev" }), "npm run *");
  assert.equal(proposePattern("Bash", { command: "ls -la" }), "ls *");
  assert.equal(
    proposePattern("Write", { file_path: "src/handlers/x.ts" }, WS),
    "src/handlers/*",
  );
  assert.equal(
    proposePattern("WebFetch", { url: "https://api.github.com/x" }),
    "api.github.com",
  );
});

test("legacy always-lists migrate to bare rules, deny first", () => {
  const rules = deriveTrustRules({
    allowAlwaysTools: ["Bash", "Read"],
    denyAlwaysTools: ["WebFetch"],
  });
  assert.deepEqual(
    rules.map((r) => `${r.effect}:${r.tool}`),
    ["deny:WebFetch", "allow:Bash", "allow:Read"],
  );
  assert.equal(verdict(rules, "Bash", { command: "anything" }), "allow");
  assert.equal(verdict(rules, "WebFetch", { url: "https://x.com" }), "deny");
});

test("explicit rules take precedence over migrated legacy duplicates", () => {
  const rules = deriveTrustRules({
    trustRules: [rule("deny", "Bash")],
    allowAlwaysTools: ["Bash"],
  });
  assert.equal(verdict(rules, "Bash", { command: "ls" }), "deny");
});

test("parseDuration handles m/h and caps at 24h", () => {
  assert.equal(parseDuration("30m"), 30 * 60_000);
  assert.equal(parseDuration("45"), 45 * 60_000);
  assert.equal(parseDuration("2h"), 2 * 3_600_000);
  assert.equal(parseDuration("99h"), 24 * 3_600_000);
  assert.equal(parseDuration("nope"), null);
  assert.equal(parseDuration("0m"), null);
});

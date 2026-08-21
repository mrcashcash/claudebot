# Design 001: Autonomous Work Queue

**Author:** david@myhr-saas.com (with Claude)
**Date:** 2026-08-21
**Status:** Implemented (all five stages) — 2026-08-21. See §11 for what changed during the build.
**Scope:** this repo (`claudebot`)

---

## 1. The constraint worth breaking

One chat is one blocking thread of work.

`kickOffTurn` in [src/core/turnEngine.ts:185](src/core/turnEngine.ts#L185) chains every turn for a chat onto a single tail Promise (`turnTailsMap`), so turns run strictly serially. That is the right default for a conversation — it's what keeps "do X" / "now do Y" coherent — but it means:

- A 20-minute refactor is 20 minutes of dead chat. You can't ask an unrelated question while it runs.
- The turn holds a `canUseTool` promise open waiting for an inline button ([src/handlers/toolApprovals.ts](src/handlers/toolApprovals.ts)), so you have to stay in the conversation to babysit it.
- `/cancel` is the only escape, and it kills the whole turn.

Three pieces of evidence that the current trust model is also at its limit:

1. This DM has `Bash`, `PowerShell`, `Read`, `Edit`, `Write`, `Grep` in `allowAlwaysTools` — that is `bypassPermissions` wearing a hat. The binary allow/deny-by-tool-name model (`ruleMatches` at [src/handlers/toolApprovals.ts:96](src/handlers/toolApprovals.ts#L96) is an exact-string `includes`) gives no way to say "npm test yes, git push no."
2. Cron-fired turns auto-deny everything not pre-approved ([src/handlers/toolApprovals.ts:267](src/handlers/toolApprovals.ts#L267)) because nobody is awake to tap a button. Autonomy today therefore requires the blanket grant from (1).
3. Chat cost is tracked (`ChatState.totalCostUsd`) but never enforced. Live numbers: $71.94 in the motorcycle_tracker chat, $56.09 in cloudexpert, $17.34 in a group. Nothing would stop a runaway loop from spending $500.

**The goal:** dispatch work from your phone, let it run detached, get pinged when it lands — with a trust model that makes that safe and a spend ceiling that makes it survivable.

```
/bg fix the failing tests on main and open a PR
→ 🎫 task#7 queued · worktree .worktrees/task-7 · budget $5
   ... chat stays live; you can talk to Claude normally ...
→ 🎫 task#7 · 6m · $1.20 · running: 3 files changed, 12/14 tests passing
→ 🎫 task#7 ✅ done · 14m · $2.10 · branch task/7 · PR #42
   [ Diff ]  [ Merge ]  [ Discard ]
```

## 2. Non-goals

- Not a job runner for arbitrary shell scripts. A task is always a Claude turn.
- No multi-machine routing (`/host home`). Complementary, deliberately later — see §8.
- No web dashboard. `/tasks` in chat is the UI, consistent with "the bots are the only interfaces."
- Not replacing crons. Crons stay the time trigger; tasks are the execution unit they can dispatch into.

## 3. Staging

| Stage | What | Size | Unlocks |
|---|---|---|---|
| 0 | Budget ceilings | ~150 LOC | Safety floor for everything below |
| 1 | Trust policy engine | ~400 LOC | Unattended tool use without a blanket grant |
| 2 | Detached tasks + worktrees | ~700 LOC | The actual feature |
| 3 | Escalation-on-pause | ~250 LOC | Tasks survive hitting an ungated tool |
| 4 | Event triggers | ~400 LOC | The bot notices things instead of being poked |

Stages 0–1 are useful shipped alone. Stage 2 without 1 is a footgun, and without 3 it's brittle.

---

## 4. Stage 0 — Budget ceilings

**Behavior.** Per-chat and per-user monthly caps, plus a hard per-turn cap. At 80% of a cap, warn in-chat; at 100%, refuse new turns with a message naming the cap and how to raise it. `/budget` shows and sets.

**Why first.** It is the cheapest possible insurance, and every later stage increases the blast radius of a loop. It also has a free half already built: `askClaude` now accepts `maxBudgetUsd` ([src/services/claude.ts](src/services/claude.ts), added for `session_ask`), so the per-turn ceiling is a one-line pass-through.

**Files**

- `src/state/store.ts` — add to `UserConfig`: `budget?: { monthlyUsd?: number; perTurnUsd?: number }`. Add to `ChatState`: `monthUsd?: number`, `monthKey?: string` (e.g. `"2026-08"`), `budgetUsd?: number`.
- `src/core/turnEngine.ts` — in `runTurn` before `askClaude`: roll the month bucket if `monthKey` changed, check the cap, bail with a reply if exceeded. Pass `maxBudgetUsd` through. The existing post-turn `sessions.update` that accumulates `totalCostUsd` also increments `monthUsd`.
- `src/handlers/commandRunner.ts` + `src/handlers/commandShared.ts` — `/budget [monthly <usd>|turn <usd>|off]`, written with `writeOverride` so it scopes chat-in-groups / user-in-DMs like the other settings. Add to `COMMAND_MENU`.
- `src/handlers/commandRunner.ts` — surface month-to-date in `/cost` and `/status`.

**Gotchas.** A cron fire that trips the cap must notify rather than fail silently — route through the transport's `getNotify` ([src/scheduler/transport.ts:44](src/scheduler/transport.ts#L44)). The cap must be checked *after* the queue dequeues, not at enqueue time, or a queued turn can be stale-refused.

---

## 5. Stage 1 — Trust policy engine

**Behavior.** Replace exact-name allow/deny lists with ordered pattern rules, and add grants that expire.

```
/trust                                  → show the rule table
/trust allow Bash(npm run *)
/trust allow Write(src/**)
/trust deny  Bash(git push *)           → deny wins over allow
/trust grant 30m                        → time-boxed "allow anything" for this chat
/trust revoke 3
```

Rule syntax deliberately mirrors the SDK's own settings format — this repo already carries `Bash(npm run *)` and `Bash(git stash *)` in `.claude/settings.local.json`, so the shape is familiar and copy-pasteable.

**Matching semantics** (all decided up front; ambiguity here is where security bugs live):

- A rule is `Tool` or `Tool(arg-pattern)`. Bare `Tool` matches any input — i.e. exactly today's behavior, so existing `allowAlwaysTools` entries migrate 1:1 with no user action.
- `arg-pattern` is glob-matched against **one canonical string per tool**, defined in a single table: `Bash`/`PowerShell` → the command; `Write`/`Edit`/`Read` → the workspace-relative path; `WebFetch` → the URL host; MCP tools → the JSON of their input. That table is the security boundary and belongs in one file with tests.
- Evaluation order: explicit deny → explicit allow → active grant → escalate/prompt. Deny always wins.
- Path patterns resolve to absolute and must stay inside the workspace, reusing the containment check already written in `isInsideWorkspace` ([src/services/sendFileMcp.ts](src/services/sendFileMcp.ts)) — pull it into a shared helper rather than copying it.

**Files**

- **New** `src/handlers/trustPolicy.ts` — `Rule` type, parser, canonicalizer table, `evaluate(toolName, input, rules, grants): "allow" | "deny" | "prompt"`. Pure, no I/O. This is the piece to unit-test even though the repo has no test harness today (`npm run typecheck` is the only check) — worth adding `node:test` here specifically.
- `src/state/store.ts` — `ChatState.trustRules?: Rule[]`, `ChatState.grants?: { untilMs: number; scope: "chat" | "task"; taskId?: string }[]`. Keep `allowAlwaysTools`/`denyAlwaysTools` readable for one release and migrate on load, the way `crons.ts` migrates legacy untagged rows in `parseStore`.
- `src/handlers/toolApprovals.ts` — `ruleMatches` becomes a call into `trustPolicy.evaluate`. The **Always** button writes a *pattern* rule instead of a bare tool name: for `Bash` propose `Bash(<first token> *)` (i.e. `npm *`), for `Write`/`Edit` propose the file's directory. Present that as a third button — "Always (npm *)" — so the user is choosing the generalization, not discovering it later.
- `src/handlers/commandRunner.ts`, `commandShared.ts` — `/trust` subcommands; keep `/rules` as an alias that prints the new table.

**Gotchas.** Grants must be checked against wall clock at evaluation time, never cached per turn. `SESSIONS_READONLY_TOOLS` and the `mcp__scheduler__` short-circuit stay ahead of the policy check — they're bot-internal, not user-policy. And the prompt text in `formatToolPrompt` should show *which rule* would be created, or "Always" becomes a blind click.

---

## 6. Stage 2 — Detached tasks + worktrees

**Behavior.** `/bg <prompt>` creates a task: its own session, its own git worktree, its own budget, running off the chat's serial queue. `/tasks` lists them, `/task <id>` shows detail and streams the latest progress line, `/kill <id>` aborts.

### 6.1 Task store

**New** `src/state/tasks.ts`, modeled directly on [src/state/crons.ts](src/state/crons.ts) — same atomic `tmp + rename` persist, same debounced `fs.watch`, same 8-char `freshId()`.

```ts
export interface Task {
  id: string;                    // "t7a2xk91"
  chatId: string;                // where to report
  userId: number | string;
  transport: Transport;          // reuse crons.ts's type + registry
  prompt: string;
  status: "queued" | "running" | "paused" | "done" | "failed" | "killed" | "interrupted";
  sessionId?: string;            // checkpoint — set from onSessionId
  worktree?: { path: string; branch: string; baseCommit: string };
  workspaceDir: string;          // the repo the worktree came from
  budgetUsd: number;
  costUsd: number;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  progress?: string;             // last streamed line, for /tasks
  progressMessageId?: string;    // the live-edited chat message
  result?: string;
  error?: string;
  pausedOn?: { tool: string; toolUseId: string; inputSummary: string };
}
```

### 6.2 Running a task

**New** `src/core/taskRunner.ts`. It is `runTurn` with four differences, and it should *share* code with it rather than fork it — extract the common body of [src/core/turnEngine.ts:237](src/core/turnEngine.ts#L237) into a `runClaudeTurn(ctx)` that both call:

1. **Not on the chat queue.** Tasks get their own concurrency limiter (default 2, `maxConcurrentTasks` in user config) instead of `turnTailsMap`. Their AbortControllers live in a separate map so `/cancel` doesn't kill them and `/kill <id>` doesn't kill the conversation.
2. **cwd is the worktree**, overriding `users.effectiveWorkspace(...)`. Pass the original workspace in `additionalDirectories` for read access to anything outside the worktree.
3. **`triggerSource: "task"`** — a third value alongside `"user" | "cron"` in `TriggerSource`. Policy: consult trust rules (Stage 1); on `prompt`, escalate (Stage 3) instead of the cron path's flat deny.
4. **Progress reporting** via `onTextDelta`: throttle to one message edit per ~10s using the existing `createStreamingReply` machinery, so a long task shows a heartbeat rather than silence.

### 6.3 Worktrees

**New** `src/services/worktree.ts`: `create(repoDir, taskId)` → `git worktree add <repo>/.worktrees/task-<id> -b task/<id>`, plus `diffStat`, `merge` (fast-forward or `--no-ff` into the base branch), `discard` (`git worktree remove --force` + branch delete), and `list` for reconciliation on boot.

Why worktrees and not "just run in the repo":

- Two concurrent tasks in one repo would fight over files; worktrees make parallelism actually safe.
- A task's output becomes **reviewable**: a branch you diff and merge from chat buttons, instead of trusting an autonomous edit blind. This is what makes unattended work palatable.
- Self-editing this bot no longer restarts it mid-task. [scripts/dev.mjs](scripts/dev.mjs) watches only `<repo>/src` recursively, so a worktree at `<repo>/.worktrees/task-7/src` is invisible to it — a task that edits claudebot runs to completion, *then* you merge, *then* the reload fires. Today the same work triggers a reload mid-flight (deferred, but still queued).

Gotchas: add `.worktrees/` to `.gitignore`; refuse task creation if the workspace isn't a git repo (fall back to running in-place with a warning, or refuse — decide, see §9); and never create a worktree inside another worktree.

### 6.4 Buttons and the click router

Task actions need a new callback namespace `task:<action>:<id>`, routed like the existing ones:

- `src/handlers/clickRouter.ts` — add `dispatchTaskClick` next to `dispatchQuestionClick` / `dispatchApprovalClick`.
- `src/telegram/actions.ts:44` — already forwards all `callbackQuery("data")`, so it just needs the new prefix branch.
- `src/slack/actions.ts:17` — the regex `/^(?:perm|q):/` must become `/^(?:perm|q|task):/`. Easy to miss; Slack buttons will silently no-op otherwise.

### 6.5 Lifecycle interactions (the subtle part)

- **The `.busy` sentinel.** [src/lifecycle/busy.ts](src/lifecycle/busy.ts) writes `data/.busy` while any turn is in flight, and [scripts/dev.mjs](scripts/dev.mjs) (which is what `npm run dev` actually runs — a custom runner, not `tsx watch`) defers its restart while the file exists. A 40-minute task holding that sentinel would block every dev reload. Tasks must **not** acquire it — instead, tasks are checkpointed (below) and a reload is allowed to interrupt them.
- **Shutdown.** [src/index.ts:39](src/index.ts#L39) drains `engine.turnTails()` for up to 30 minutes. Tasks deliberately opt out of that drain: on shutdown, running tasks are marked `interrupted` with their `sessionId` intact.
- **Resume after restart.** On boot, every `running` task becomes `interrupted`, and the chat gets one message per task: "task#7 was interrupted by a reload — [Resume] [Discard]". Resume = a new turn with `resume: sessionId` and a "continue where you left off" prompt. This is only possible because `onSessionId` already persists the session id the moment `system/init` arrives — the same property that makes `/resume` work.
- **Cost.** Task spend accumulates on the task row *and* rolls into `ChatState.totalCostUsd` / the Stage-0 month bucket, so budgets can't be dodged by moving work into tasks.
- **Crons dispatch into tasks.** Once tasks exist, `resume: false` crons are better modeled as "create a task," which gets them progress reporting, budgets and escalation for free. `scheduler/runner.ts` keeps the existing path for one release, then switches.

---

## 7. Stage 3 — Escalation-on-pause

**Behavior.** A task that hits a tool the policy won't auto-allow does not die (today's cron behavior) and does not hang forever waiting on a click. It:

1. posts the normal Allow/Always/Deny/Never prompt to the chat, tagged with the task id;
2. sets `status: "paused"` and `pausedOn`, then **releases its concurrency slot** so other tasks proceed;
3. resumes on the tap — via `resume: sessionId` — or auto-fails after a configurable window (default 24h).

This is the difference between "autonomy that works while you sleep" and "autonomy that dies at the first `git push`." It needs the approvals registry ([src/handlers/approvals.ts](src/handlers/approvals.ts)) to survive a process restart, which today it does not: it's an in-memory `Map` and `finalize()` denies everything pending. Persisting pending approvals to the task row (not to the map) is the actual work here.

**Files:** `src/handlers/approvals.ts` (durable pending state), `src/handlers/toolApprovals.ts` (the `"task"` branch), `src/core/taskRunner.ts` (pause/resume), `src/state/tasks.ts`.

---

## 8. Stage 4 — Event triggers

Crons already prove the whole dispatch chain: a registry keyed by transport ([src/scheduler/transport.ts](src/scheduler/transport.ts)), a `fire()` that builds a prompt ([src/scheduler/runner.ts](src/scheduler/runner.ts)), a 60s ticker with catch-up and idempotency via `lastFiredAt`. They just only listen to one thing: the clock.

**New** `src/watchers/` with the same shape — a registry of sources, each emitting `{ sourceId, dedupeKey, promptContext }`:

- `git` — new commits on a branch, or a PR opened (via `gh`); "review this diff and report."
- `fs` — a path changes; "regenerate X."
- `http` — poll a URL/webhook JSON for a state change (CI red, Sentry spike, deploy finished).
- `log` — a pattern appears in a log file.

Each firing creates a **task** (Stage 2), so it inherits budget, escalation and reporting. `dedupeKey` plays the role `lastFiredAt` plays for crons: fire once per commit sha / PR number / error fingerprint, idempotent across restarts.

This is also the natural point to add **multi-machine routing** (`/host home`), because by then the unit of work is a task row rather than a chat — routing a task to a worker is a field, not an architecture change. Deliberately out of scope here.

---

## 9. Open questions — as resolved

All five were decided as recommended and are now implemented:

1. **Non-git workspaces** — allowed with a warning, capped at one task per workspace, **and** forced to `permissionMode: "default"` (an addition; see §11).
2. **Merge conflicts** — reported and aborted, never auto-resolved. The branch survives so the user can resolve it or start a follow-up task.
3. **Concurrency default** — per-user default 2 (`maxConcurrentTasks`), global ceiling `min(4, cpus-2)`.
4. **"Always" generalization** — not editable in chat. The button offers exactly one narrow proposal (`npm run *`, `src/handlers/*`); anything wider must be typed as `/trust allow <rule>`.
5. **Paused tasks hold their worktree** — yes, and `discard` cleans up both the worktree and the pending approval.

### Original wording



1. **Non-git workspaces** — refuse `/bg`, or run in-place with no isolation and a loud warning? (Leaning: allow with a warning, cap concurrency at 1 for that workspace.)
2. **Merge conflicts on task completion** — auto-rebase and re-run, or hand it back to the user? (Leaning: report the conflict, let the user open a follow-up task.)
3. **Concurrency default** — 2 tasks feels right for a dev box, but each task is a full Claude process. Tie the default to CPU count?
4. **Should the "Always" button's proposed generalization be editable?** A wrong generalization is worse than no rule. Maybe Always always proposes the narrowest pattern and `/trust allow` is the only way to widen.
5. **Does a paused task hold its worktree?** Yes — but a `discard` on a paused task must clean up both the worktree and the pending approval.

## 10. Why this order (unchanged, and it held up)

Budget caps are insurance you want before you increase blast radius. The policy engine is what makes unattended tool use anything other than a blanket grant — build it before the thing that needs it. Tasks are the actual feature but they're a footgun without the two below them. Escalation is what makes tasks robust rather than demo-quality. Event triggers are the payoff: the bot stops being something you poke and starts being something that notices.

## 11. What the build changed

Four things the design got wrong or didn't know, all found by testing rather than review:

**The permission gate sits lower than assumed.** `canUseTool` is never consulted for calls Claude Code itself judges safe. Measured, in this repo: `git push` and `WebFetch` reach the callback; `echo probe`, `git log`, and — under `acceptEdits` — even `rm note.txt` do not. So trust rules govern consequential and remote operations, while local mutations are governed by the permission mode. Consequence: an in-place task (no worktree to contain a mistake) now forces `permissionMode: "default"`, which was verified to gate the same `rm` that `acceptEdits` waved through. This is the one place the implementation is stricter than the design.

**`Write(**)` matched outside the workspace.** The first version of the matcher globbed against an absolute path when the target was outside the workspace, so a broad-looking project rule also covered `C:\Windows\...`. Fixed: a relative pattern can never match an absolute path, and reaching out must be spelled `Write(C:/tmp/**)`. Caught by `trustPolicy.test.ts`, which is the argument for having written it.

**`.worktrees/` made every merge look unsafe.** The worktree directory lives inside the repo, so an un-ignored one shows as untracked and the "is the main tree clean?" check refused every merge. Fixed in two places: the check filters the path, and `create()` appends `.worktrees/` to `.git/info/exclude` (not the user's tracked `.gitignore`).

**Resume was silently a no-op.** `resumeTask` set the status to `queued` but never pushed the id onto the queue, and `pump()` didn't guard against starting an already-running task. Approving a paused tool therefore did nothing — and it would always have been hit in practice, because the pause prompt is sent from inside `canUseTool`, well before the previous run has exited. Both fixed; the end-to-end probe now covers pause → approve → resume-in-same-session.

**Verification.** 16 unit tests over the matcher (`npm test`); throwaway probes — since removed — exercised the worktree lifecycle (18 assertions incl. conflict abort), the task runner against real Claude turns (pause/approve/resume, worktree containment, exact cost accounting across 6 tasks), and all four watcher sources (29 assertions incl. log rotation and `node_modules` exclusion).

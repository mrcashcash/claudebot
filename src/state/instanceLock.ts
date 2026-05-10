import fs from "node:fs";
import path from "node:path";
import os from "node:os";

interface LockInfo {
  pid: number;
  startedAt: number;
  heartbeatAt: number;
  hostname: string;
  nodeVersion: string;
  transports: string[];
}

const DATA_DIR = path.join(process.cwd(), "data");
const LOCK_PATH = path.join(DATA_DIR, ".instance.lock");

const HEARTBEAT_INTERVAL_MS = 60 * 1000;
// A held lock whose heartbeat is older than this is treated as stale, even if
// the recorded PID is still alive. Defends against PID reuse on long-running
// hosts and against a frozen process whose event loop is blocked.
const HEARTBEAT_TTL_MS = 5 * 60 * 1000;

let acquired = false;
let heartbeatHandle: NodeJS.Timeout | null = null;
let currentPayload: LockInfo | null = null;
let exitHandlerRegistered = false;

export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

function formatExistingLockError(file: string, raw: string): Error {
  let parsed: Partial<LockInfo> = {};
  try {
    parsed = JSON.parse(raw) as Partial<LockInfo>;
  } catch {
    parsed = {};
  }
  const pid = typeof parsed.pid === "number" ? String(parsed.pid) : "<unknown>";
  const startedAt =
    typeof parsed.startedAt === "number"
      ? new Date(parsed.startedAt).toISOString()
      : "<unknown>";
  const hostname =
    typeof parsed.hostname === "string" ? parsed.hostname : "<unknown>";
  const transports = Array.isArray(parsed.transports)
    ? parsed.transports.join(", ")
    : "<unknown>";
  return new Error(
    [
      "Another botcode instance is already running.",
      `  pid:        ${pid}`,
      `  startedAt:  ${startedAt}`,
      `  hostname:   ${hostname}`,
      `  transports: ${transports}`,
      `Lockfile:    ${file}`,
      "Stop the other instance first, or delete the lockfile if you're sure it's stale.",
    ].join("\n"),
  );
}

function writeLockExclusive(file: string, payload: LockInfo): void {
  const json = JSON.stringify(payload, null, 2);
  const fd = fs.openSync(file, "wx");
  try {
    fs.writeSync(fd, json);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeLockOverwriting(file: string, payload: LockInfo): void {
  const json = JSON.stringify(payload, null, 2);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, file);
}

function isHeldByLiveProcess(parsed: Partial<LockInfo>, now: number): boolean {
  const pid = typeof parsed.pid === "number" ? parsed.pid : NaN;
  if (!Number.isFinite(pid) || pid === process.pid) return false;

  // PID checks only work on the local host. If the lockfile was written by a
  // different host (shared filesystem), trust the heartbeat alone — checking
  // process.kill(pid, 0) here would ask "is that pid alive on MY host", which
  // is meaningless and almost always wrong.
  const sameHost =
    typeof parsed.hostname === "string"
      ? parsed.hostname === os.hostname()
      : true;
  if (sameHost && !isPidAlive(pid)) return false;

  const beat =
    typeof parsed.heartbeatAt === "number" ? parsed.heartbeatAt : null;
  // Pre-heartbeat lockfile (no heartbeatAt): on the same host, fall back to
  // pid-alive only. On a different host, treat as stale — we cannot verify it.
  if (beat === null) return sameHost;
  return now - beat <= HEARTBEAT_TTL_MS;
}

/** Trigger a graceful shutdown via SIGTERM rather than calling process.exit
 *  directly. The orchestrator's shutdown handler will notify in-flight chats,
 *  write the restart marker, drain turns, and stop transports — all the things
 *  a hard exit would skip. Idempotent because shutdown() is. */
function selfEvict(reason: string): void {
  console.error(`[instanceLock] ${reason}; triggering graceful shutdown`);
  stopHeartbeat();
  acquired = false;
  process.kill(process.pid, "SIGTERM");
}

function refreshHeartbeat(): void {
  if (!acquired || !currentPayload) return;
  // Verify we still own the file. If something evicted us (cleared the lock,
  // wrote their own), trigger graceful shutdown — the other instance is the
  // rightful owner and we should not keep polling Telegram/Slack on the same
  // tokens, but we still want to drain in-flight turns and notify users.
  let raw: string;
  try {
    raw = fs.readFileSync(LOCK_PATH, "utf8");
  } catch {
    selfEvict("lockfile vanished from under us");
    return;
  }
  let parsed: Partial<LockInfo> = {};
  try {
    parsed = JSON.parse(raw) as Partial<LockInfo>;
  } catch {
    parsed = {};
  }
  if (parsed.pid !== process.pid) {
    selfEvict(`lost ownership (file now held by pid ${parsed.pid})`);
    return;
  }
  const next: LockInfo = { ...currentPayload, heartbeatAt: Date.now() };
  try {
    writeLockOverwriting(LOCK_PATH, next);
    currentPayload = next;
  } catch (err) {
    console.warn("[instanceLock] heartbeat write failed:", err);
  }
}

function startHeartbeat(): void {
  if (heartbeatHandle) return;
  heartbeatHandle = setInterval(refreshHeartbeat, HEARTBEAT_INTERVAL_MS);
  // Don't keep the event loop alive just for the heartbeat — if everything
  // else has shut down, we want the process to exit and `release()` (via
  // process.on("exit")) to clean up the file.
  heartbeatHandle.unref();
}

function stopHeartbeat(): void {
  if (!heartbeatHandle) return;
  clearInterval(heartbeatHandle);
  heartbeatHandle = null;
}

function ensureExitHandler(): void {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;
  process.on("exit", () => release());
}

/** Atomically take ownership of a lockfile path that we believe is stale.
 *  Renames the existing file out of the way (rename is atomic on POSIX and
 *  same-volume on Windows); if rename fails because the file is gone or has
 *  changed shape underneath us, surface the current state instead of stomping. */
function clearStaleAtomically(file: string, expectedRaw: string): void {
  const cleared = `${file}.cleared-${process.pid}-${Date.now()}`;
  try {
    fs.renameSync(file, cleared);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return; // someone else cleared it; fine
    throw err;
  }
  // Verify what we actually moved matches what we read. If it doesn't, a
  // third instance wrote a fresh lock between our read and our rename — put
  // it back and bail.
  let movedRaw = "";
  try {
    movedRaw = fs.readFileSync(cleared, "utf8");
  } catch {
    movedRaw = "";
  }
  if (movedRaw !== expectedRaw) {
    try {
      fs.renameSync(cleared, file);
    } catch {
      // Best-effort restore; if it fails, the next instance will see ENOENT
      // and create fresh, which is still safer than stomping.
    }
    throw formatExistingLockError(file, movedRaw || expectedRaw);
  }
  try {
    fs.unlinkSync(cleared);
  } catch {
    // Leftover .cleared-* file is harmless; ignore.
  }
}

export function acquire(transports: string[]): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const now = Date.now();
  const payload: LockInfo = {
    pid: process.pid,
    startedAt: now,
    heartbeatAt: now,
    hostname: os.hostname(),
    nodeVersion: process.version,
    transports,
  };

  try {
    writeLockExclusive(LOCK_PATH, payload);
    acquired = true;
    currentPayload = payload;
    startHeartbeat();
    ensureExitHandler();
    console.log(
      `[instanceLock] acquired (pid ${process.pid}, transports: ${transports.join(", ")})`,
    );
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err;
    }
  }

  // Lockfile already exists. Decide stale vs. live.
  let raw = "";
  try {
    raw = fs.readFileSync(LOCK_PATH, "utf8");
  } catch {
    raw = "";
  }

  let parsed: Partial<LockInfo> = {};
  try {
    parsed = JSON.parse(raw) as Partial<LockInfo>;
  } catch {
    parsed = {};
  }

  if (isHeldByLiveProcess(parsed, now)) {
    throw formatExistingLockError(LOCK_PATH, raw);
  }

  // Stale: dead pid, missing/invalid pid, our own pid, unparseable JSON, or
  // heartbeat older than the TTL. Clear and retry.
  const heldPidAge =
    typeof parsed.heartbeatAt === "number"
      ? `${Math.round((now - parsed.heartbeatAt) / 1000)}s`
      : "unknown";
  const heldPid = typeof parsed.pid === "number" ? parsed.pid : "<unknown>";
  console.warn(
    `[instanceLock] clearing stale lockfile (pid=${heldPid}, last heartbeat ${heldPidAge} ago)`,
  );

  clearStaleAtomically(LOCK_PATH, raw);

  try {
    writeLockExclusive(LOCK_PATH, payload);
    acquired = true;
    currentPayload = payload;
    startHeartbeat();
    ensureExitHandler();
    console.log(
      `[instanceLock] acquired (pid ${process.pid}, transports: ${transports.join(", ")})`,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      // Another process raced us through the same stale-clear.
      let raw2 = "";
      try {
        raw2 = fs.readFileSync(LOCK_PATH, "utf8");
      } catch {
        raw2 = raw;
      }
      throw formatExistingLockError(LOCK_PATH, raw2);
    }
    throw err;
  }
}

export function release(): void {
  stopHeartbeat();
  if (!acquired) return;
  acquired = false;
  try {
    fs.unlinkSync(LOCK_PATH);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[instanceLock] failed to remove lockfile:", err);
    }
  }
}

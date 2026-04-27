// Prevents the host computer from sleeping while the gateway is running.
// Windows-only; no-op on other platforms.
//
// Implementation: spawn a tiny PowerShell helper that calls
// SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED). The flag is
// scoped to the helper process, so Windows clears it automatically when the
// helper exits — even on hard crash. The helper also watches the parent PID
// and exits if the gateway dies without calling stop().
//
// Note: ES_SYSTEM_REQUIRED keeps the system awake but lets the display turn
// off normally. We don't set ES_DISPLAY_REQUIRED.

import { spawn, type ChildProcess } from "node:child_process";

let helper: ChildProcess | null = null;

const PS_SCRIPT = `
param([int]$ParentPid)
$sig = '[DllImport("kernel32.dll", SetLastError=true)] public static extern uint SetThreadExecutionState(uint esFlags);'
$api = Add-Type -MemberDefinition $sig -Name "PowerApi" -Namespace "BotCode" -PassThru
# ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x00000001)
[void]$api::SetThreadExecutionState([uint32]2147483649)
while ($true) {
  if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Seconds 30
}
`;

export function start(): void {
  if (process.platform !== "win32") return;
  if (helper) return;
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      PS_SCRIPT,
      "-ParentPid",
      String(process.pid),
    ],
    { stdio: "ignore", windowsHide: true, detached: false },
  );
  child.on("error", (err) => {
    console.warn("[keepalive] helper failed to start:", err);
    helper = null;
  });
  child.on("exit", () => {
    if (helper === child) helper = null;
  });
  child.unref();
  helper = child;
  console.log("[keepalive] system sleep prevented while bot is running");
}

export function stop(): void {
  if (!helper) return;
  try {
    helper.kill();
  } catch {
    // ignore — process may already be gone
  }
  helper = null;
}

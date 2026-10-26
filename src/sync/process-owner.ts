import { execFileSync } from "node:child_process";
import { dlopen, ptr } from "bun:ffi";
import fs from "node:fs";
import type { SyncRunResult } from "./contracts";

export interface ProcessBirth {
  identity: string;
  startedAt: number;
}

type Owner = Pick<SyncRunResult, "ownerPid" | "ownerProcessStart" | "startedAt">;
let ownBirth: ProcessBirth | undefined;
const openWindowsApi = () => dlopen("kernel32.dll", {
  OpenProcess: { args: ["u32", "i32", "u32"], returns: "ptr" },
  GetProcessTimes: { args: ["ptr", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
  CloseHandle: { args: ["ptr"], returns: "i32" },
});
let windowsApi: ReturnType<typeof openWindowsApi> | undefined;

/** A PID can belong to another process after a restart. Read its OS birth identity. */
export function readProcessBirth(pid: number): ProcessBirth | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (pid === process.pid && ownBirth) return ownBirth;
  try {
    let birth: ProcessBirth;
    if (process.platform === "win32") {
      const api = (windowsApi ??= openWindowsApi()).symbols;
      const handle = api.OpenProcess(0x1000, 0, pid);
      if (!handle) return undefined;
      const times = new BigUint64Array(4);
      try {
        if (!api.GetProcessTimes(handle, ptr(times), ptr(times, 8), ptr(times, 16), ptr(times, 24))) return undefined;
      } finally { api.CloseHandle(handle); }
      const ticks = times[0]!;
      birth = { identity: `win32:${ticks}`, startedAt: Number((ticks - 116444736000000000n) / 10000n) };
    } else {
      const stamp = execFileSync("ps", ["-p", String(pid), "-o", "lstart="],
        { encoding: "utf8", timeout: 5_000, env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, stdio: ["ignore", "pipe", "pipe"] }).trim();
      let identity = `${process.platform}:${stamp}`;
      if (process.platform === "linux") {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
        const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
        if (!ticks || !/^\d+$/.test(ticks)) return undefined;
        identity = `linux:${boot}:${ticks}`;
      }
      birth = { identity, startedAt: Date.parse(`${stamp} UTC`) };
    }
    if (!birth.identity || !Number.isFinite(birth.startedAt)) return undefined;
    if (pid === process.pid) ownBirth = birth;
    return birth;
  } catch {
    // An unreadable process is not proof that a live writer can be replaced.
    return undefined;
  }
}

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Legacy runs have no birth identity; a process born after the run cannot own it. */
export function syncOwnerAlive(owner: Owner, birthOf = readProcessBirth, alive = processAlive): boolean {
  const pid = owner.ownerPid;
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0 || !alive(pid)) return false;
  const birth = birthOf(pid);
  if (!birth) return alive(pid);
  if (owner.ownerProcessStart !== undefined) return owner.ownerProcessStart === birth.identity;
  const startedAt = Date.parse(owner.startedAt);
  return !Number.isFinite(startedAt) || birth.startedAt <= startedAt;
}

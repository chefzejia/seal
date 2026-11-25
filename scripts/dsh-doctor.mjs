import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = new Set(process.argv.slice(2));
const applyFix = args.has("--fix");
const killAll = args.has("--kill-all");
const pruneTestSessions = args.has("--prune-test-sessions");

if (args.has("--help") || args.has("-h")) {
  console.log(
    [
      "Usage: node scripts/dsh-doctor.mjs [--fix] [--kill-all] [--prune-test-sessions]",
      "",
      "Inspects and repairs common DeepSeek Harness Desktop lock/contention issues:",
      "  (no flags)            Read-only health report",
      "  --fix                 Gracefully stop test-sandbox DSH procs (SIGTERM), clear dead",
      "                        launchd zombie entries, and remove stale Singleton* lock files",
      "  --kill-all            With --fix, also gracefully stop non-test DeepSeek Harness procs",
      "  --prune-test-sessions With --fix (and no running DSH), remove temporary .tmp/var-folders",
      "                        test session buckets, junk workspaces, and orphaned cache files",
    ].join("\n"),
  );
  process.exit(0);
}

const home = os.homedir();
const dshHome = process.env.DSH_HOME?.trim() || path.join(home, ".dsh");
const userDataDir =
  process.platform === "darwin"
    ? path.join(home, "Library", "Application Support", "@deepseek-ai", "dsh-desktop")
    : path.join(home, ".config", "@deepseek-ai", "dsh-desktop");

function runCapture(cmd, cmdArgs) {
  try {
    return execFileSync(cmd, cmdArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return "";
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function listDshProcesses() {
  const out = runCapture("ps", ["-axo", "pid=,ppid=,command="]);
  const procs = [];
  for (const rawLine of out.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const command = match[3];
    if (pid === process.pid) continue;
    if (!/(?:^|\/)DeepSeek Harness\.app\/Contents\/MacOS\/DeepSeek Harness(?:\s|$)/.test(command)) continue;
    if (/^(?:zsh|bash|sh|fish)\b/.test(command)) continue;
    // Ignore helper sub-processes; target the main Electron process (no --type=)
    if (command.includes(" --type=")) continue;
    const envOut = process.platform === "darwin" ? runCapture("ps", ["eww", "-p", String(pid)]) : "";
    const isTestSandbox =
      command.includes(".tmp") ||
      command.includes("--user-data-dir=") ||
      /SEAL_HOME=[^\s]*\.tmp/.test(envOut) ||
      /DSH_HOME=[^\s]*\.tmp/.test(envOut);
    procs.push({ pid, ppid, command, isTestSandbox });
  }
  return procs;
}

function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function stopProcessGracefully(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return !isPidAlive(pid);
  }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    sleepSync(200);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
  sleepSync(300);
  return !isPidAlive(pid);
}

function listLaunchdDshJobs() {
  if (process.platform !== "darwin") return [];
  const out = runCapture("launchctl", ["list"]);
  const jobs = [];
  for (const line of out.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [pidRaw, statusRaw, label] = parts;
    if (!label.startsWith("application.com.deepseek.dsh.")) continue;
    jobs.push({ pid: pidRaw === "-" ? null : Number(pidRaw), exitStatus: Number(statusRaw), label });
  }
  return jobs;
}

function inspectSingletonLocks() {
  const lockPath = path.join(userDataDir, "SingletonLock");
  const socketPath = path.join(userDataDir, "SingletonSocket");
  const cookiePath = path.join(userDataDir, "SingletonCookie");
  const exists = (p) => {
    try {
      fs.lstatSync(p);
      return true;
    } catch {
      return false;
    }
  };
  const lockExists = exists(lockPath);
  const socketExists = exists(socketPath);
  const cookieExists = exists(cookiePath);
  if (!lockExists && !socketExists && !cookieExists) {
    return { present: false, stale: false, target: null, lockPath, socketPath, cookiePath };
  }
  let target = null;
  let host = null;
  let pid = null;
  try {
    target = fs.readlinkSync(lockPath);
    const dash = target.lastIndexOf("-");
    if (dash > 0) {
      host = target.slice(0, dash);
      const parsed = Number(target.slice(dash + 1));
      if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
    }
  } catch {
    // not a symlink or unreadable
  }
  const currentHost = os.hostname();
  const hostMismatch = Boolean(host && host !== currentHost);
  const pidDead = pid === null ? true : !isPidAlive(pid);
  const stale = !lockExists || hostMismatch || pidDead;
  return {
    present: true,
    stale,
    target,
    host,
    currentHost,
    hostMismatch,
    pid,
    pidDead,
    lockPath,
    socketPath,
    cookiePath,
  };
}

function isTempTestPath(text) {
  return (
    text.includes(".tmp") ||
    text.includes("-tmp-") ||
    text.includes("seal-home") ||
    text.includes("dsh-bundle") ||
    text.includes("desktop-e2e") ||
    text.includes("evidence") ||
    text.includes("sandbox") ||
    text.includes("var-folders") ||
    text.includes("/var/folders") ||
    text.includes("--tmp") ||
    text.includes("private-tmp") ||
    text.includes("/tmp/")
  );
}

function inspectTestJunk() {
  const sessionsRoot = path.join(dshHome, "sessions");
  const wsPath = path.join(dshHome, "storages", "workspace.json");
  const junkBuckets = [];
  const keptSessions = new Set();
  if (fs.existsSync(sessionsRoot)) {
    for (const entry of fs.readdirSync(sessionsRoot)) {
      const full = path.join(sessionsRoot, entry);
      if (!fs.statSync(full).isDirectory()) continue;
      if (isTempTestPath(entry)) {
        junkBuckets.push(entry);
      } else {
        for (const sub of fs.readdirSync(full)) {
          if (fs.statSync(path.join(full, sub)).isDirectory()) keptSessions.add(sub);
        }
      }
    }
  }
  const junkWorkspaces = [];
  if (fs.existsSync(wsPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(wsPath, "utf8"));
      const table = data?.tables?.workspaces ?? {};
      for (const [wid, info] of Object.entries(table)) {
        if (isTempTestPath(String(info?.path ?? ""))) {
          junkWorkspaces.push({ id: wid, path: info.path });
        }
      }
    } catch {
      // ignore malformed workspace.json in read-only inspection
    }
  }
  return { junkBuckets, junkWorkspaces, keptSessions };
}

function pruneTempTestData(junk) {
  const sessionsRoot = path.join(dshHome, "sessions");
  const projcacheDir = path.join(dshHome, "storages", "session_projcache", "sessions");
  const wsPath = path.join(dshHome, "storages", "workspace.json");
  let removedBuckets = 0;
  for (const bucket of junk.junkBuckets) {
    fs.rmSync(path.join(sessionsRoot, bucket), { recursive: true, force: true });
    removedBuckets++;
  }
  let removedWorkspaces = 0;
  if (junk.junkWorkspaces.length > 0 && fs.existsSync(wsPath)) {
    const data = JSON.parse(fs.readFileSync(wsPath, "utf8"));
    const junkIds = new Set(junk.junkWorkspaces.map((item) => item.id));
    for (const wid of junkIds) {
      delete data.tables.workspaces[wid];
      removedWorkspaces++;
    }
    if (Array.isArray(data.global?.workspaceIds)) {
      data.global.workspaceIds = data.global.workspaceIds.filter((id) => !junkIds.has(id));
    }
    if (Array.isArray(data.global?.archivedSessionIds)) {
      data.global.archivedSessionIds = data.global.archivedSessionIds.filter((id) => junk.keptSessions.has(id));
    }
    if (Array.isArray(data.global?.pinnedSessionIds)) {
      data.global.pinnedSessionIds = data.global.pinnedSessionIds.filter((id) => junk.keptSessions.has(id));
    }
    const tmpPath = `${wsPath}.doctor.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmpPath, wsPath);
  }
  let removedCache = 0;
  if (fs.existsSync(projcacheDir)) {
    for (const file of fs.readdirSync(projcacheDir)) {
      const full = path.join(projcacheDir, file);
      if (file.endsWith(".tmp")) {
        fs.rmSync(full, { force: true });
        removedCache++;
      } else if (file.endsWith(".json")) {
        const sid = file.slice(0, -5);
        if (!junk.keptSessions.has(sid)) {
          fs.rmSync(full, { force: true });
          removedCache++;
        }
      }
    }
  }
  return { removedBuckets, removedWorkspaces, removedCache };
}

const report = {
  mode: applyFix ? "fix" : "check",
  dshHome,
  userDataDir,
  runningProcesses: listDshProcesses(),
  actions: [],
};

if (applyFix) {
  for (const proc of report.runningProcesses) {
    if (proc.isTestSandbox || killAll) {
      const stopped = stopProcessGracefully(proc.pid);
      report.actions.push({
        type: "stop-process",
        pid: proc.pid,
        isTestSandbox: proc.isTestSandbox,
        stopped,
      });
    }
  }
  report.runningProcesses = listDshProcesses();
}

const launchdJobs = listLaunchdDshJobs();
const deadLaunchdJobs = launchdJobs.filter((job) => job.pid === null || !isPidAlive(job.pid));
report.launchdJobs = launchdJobs;
if (applyFix && report.runningProcesses.length === 0) {
  for (const job of deadLaunchdJobs) {
    try {
      execFileSync("launchctl", ["remove", job.label], { stdio: "ignore" });
      report.actions.push({ type: "remove-launchd-zombie", label: job.label });
    } catch {
      report.actions.push({ type: "remove-launchd-zombie-failed", label: job.label });
    }
  }
}

const singleton = inspectSingletonLocks();
report.singleton = singleton;
if (applyFix && singleton.present && singleton.stale && report.runningProcesses.length === 0) {
  let socketTarget = null;
  try {
    socketTarget = fs.readlinkSync(singleton.socketPath);
  } catch {
    // ignore
  }
  for (const p of [singleton.lockPath, singleton.socketPath, singleton.cookiePath]) {
    fs.rmSync(p, { force: true });
  }
  if (socketTarget && socketTarget.includes("scoped_dir")) {
    fs.rmSync(path.dirname(socketTarget), { recursive: true, force: true });
  }
  report.actions.push({ type: "remove-stale-singleton", target: singleton.target });
}

const junk = inspectTestJunk();
report.testJunk = {
  tempSessionBuckets: junk.junkBuckets.length,
  tempWorkspaces: junk.junkWorkspaces.length,
};
if (applyFix && pruneTestSessions) {
  if (report.runningProcesses.length > 0) {
    report.actions.push({
      type: "skip-prune-test-sessions",
      reason: "DeepSeek Harness is currently running; close it or pass --kill-all first.",
    });
  } else {
    const pruned = pruneTempTestData(junk);
    report.actions.push({ type: "prune-test-sessions", ...pruned });
  }
}

console.log(JSON.stringify(report, null, 2));

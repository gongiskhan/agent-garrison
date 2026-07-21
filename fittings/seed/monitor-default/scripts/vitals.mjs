#!/usr/bin/env node
// System-vitals collector for the Monitor Fitting.
//
// Split out from server.mjs so the pure pieces (disk-severity classification,
// systemd unit parsing) and the injectable systemd listing can be unit-tested
// without booting the HTTP server. Read-only: reads OS counters and lists
// systemd user units; never signals, kills, starts, or stops anything.
//
// Cross-platform metrics come from `systeminformation` (MIT). The garrison-*
// unit listing is Linux-only and degrades to [] elsewhere or on any error.

import { spawn } from "node:child_process";
import os from "node:os";
import si from "systeminformation";

// Disk-usage severity thresholds (percent used). Amber at 85, red at 95.
export const DISK_WARN_PERCENT = 85;
export const DISK_CRITICAL_PERCENT = 95;

// A hung systeminformation probe (fsSize on a stale NFS mount, networkStats on a
// flaky iface, temperature on some VMs) can NEVER resolve — and .catch() only
// handles rejection, not a promise that never settles. Since the server samples
// under a re-entrancy guard, one hang would freeze the ENTIRE vitals feed for
// the life of the process. Race every probe against a timeout that resolves to
// a fallback so a stuck field degrades to null/[] instead of wedging the loop.
// Read at CALL time (not module load) so a test can tune it after import.
function siTimeoutMs() {
  return Number(process.env.MONITOR_SI_TIMEOUT_MS || 3000);
}
function withTimeout(promise, fallback, ms = siTimeoutMs()) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms))
  ]);
}

// Pure: classify a mount's used-percentage into ok / warn / critical. Anything
// unknown (null / undefined / NaN) is treated as ok so a metric gap never
// raises a false alarm.
export function diskSeverity(usePercent) {
  const p = Number(usePercent);
  if (!Number.isFinite(p)) return "ok";
  if (p >= DISK_CRITICAL_PERCENT) return "critical";
  if (p >= DISK_WARN_PERCENT) return "warn";
  return "ok";
}

// Pure: parse the whitespace-columned output of
//   systemctl --user --plain --no-legend list-units garrison-*
// into { unit, load, active, sub, description } rows. Robust to blank lines and
// garbage: a row is only accepted when its first token looks like a systemd
// unit name (…​.service / .socket / .timer / …), so non-unit noise yields [].
export function parseSystemdUnits(stdout) {
  const units = [];
  for (const raw of String(stdout ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    const [unit, load, active, sub] = parts;
    if (!/^[\w@.\\:-]+\.[a-z]+$/i.test(unit)) continue;
    const description = parts.slice(4).join(" ");
    units.push({ unit, load, active, sub, description });
  }
  return units;
}

// Default subprocess runner for listGarrisonUnits. Resolves (never rejects)
// with { stdout, stderr, code }; a spawn error yields code -1, a timeout null.
function defaultExec(cmd, args, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({ stdout, stderr, code: -1 });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      resolve({ stdout, stderr, code: null });
    }, timeoutMs);
    child.stdout.on("data", (c) => { stdout += c.toString(); });
    child.stderr.on("data", (c) => { stderr += c.toString(); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
    child.on("error", () => { clearTimeout(timer); resolve({ stdout, stderr, code: -1 }); });
  });
}

// List garrison-* systemd *user* units. Linux-only; returns [] on any other
// platform (without spawning) and on any error. `exec` is injectable for tests.
export async function listGarrisonUnits({ platform = process.platform, exec = defaultExec } = {}) {
  if (platform !== "linux") return [];
  try {
    const { stdout } = await exec("systemctl", ["--user", "--plain", "--no-legend", "list-units", "garrison-*"]);
    return parseSystemdUnits(stdout);
  } catch {
    return [];
  }
}

async function collectCpu(loadavgFn) {
  let currentLoad = null;
  let cores = 0;
  try {
    const load = await withTimeout(si.currentLoad(), {});
    if (typeof load.currentLoad === "number") currentLoad = load.currentLoad;
    if (Array.isArray(load.cpus)) cores = load.cpus.length;
  } catch {
    // fall through — load averages below still work without si
  }
  if (!cores) {
    try { cores = os.cpus()?.length ?? 0; } catch { cores = 0; }
  }
  let load1 = null;
  let load5 = null;
  let load15 = null;
  try {
    const [l1, l5, l15] = loadavgFn();
    load1 = Number.isFinite(l1) ? l1 : null;
    load5 = Number.isFinite(l5) ? l5 : null;
    load15 = Number.isFinite(l15) ? l15 : null;
  } catch {}
  return { currentLoad, load1, load5, load15, cores };
}

async function collectMem() {
  try {
    const m = await withTimeout(si.mem(), null);
    const total = Number(m.total) || 0;
    // On Linux `active` is real in-use memory (excludes reclaimable cache), a
    // truer "used" than `used` which counts buffers/cache. Fall back to `used`.
    const used = Number(m.active) || Number(m.used) || 0;
    const free = Number(m.available) || Number(m.free) || 0;
    const usePercent = total > 0 ? (used / total) * 100 : 0;
    return { total, used, free, usePercent };
  } catch {
    return null;
  }
}

async function collectDisks() {
  try {
    const fs = await withTimeout(si.fsSize(), []);
    const arr = Array.isArray(fs) ? fs : [];
    return arr
      .filter((d) => Number(d.size) > 0)
      .map((d) => {
        const size = Number(d.size) || 0;
        const used = Number(d.used) || 0;
        const usePercent = typeof d.use === "number" ? d.use : size > 0 ? (used / size) * 100 : null;
        return {
          mount: d.mount ?? d.fs ?? "?",
          fs: d.fs ?? "",
          type: d.type ?? "",
          size,
          used,
          available: Number(d.available) || 0,
          usePercent,
          severity: diskSeverity(usePercent)
        };
      });
  } catch {
    return [];
  }
}

async function collectNet() {
  try {
    const stats = await withTimeout(si.networkStats("*"), []);
    const arr = Array.isArray(stats) ? stats : stats ? [stats] : [];
    let rxSec = 0;
    let txSec = 0;
    const interfaces = [];
    for (const s of arr) {
      // First sample per interface has no delta baseline (rx_sec/tx_sec can be
      // -1); clamp negatives to 0 so throughput never reads as negative.
      const rx = Math.max(0, Number(s.rx_sec) || 0);
      const tx = Math.max(0, Number(s.tx_sec) || 0);
      rxSec += rx;
      txSec += tx;
      interfaces.push({ iface: s.iface ?? "", rxSec: rx, txSec: tx });
    }
    return { rxSec, txSec, interfaces };
  } catch {
    return null;
  }
}

// Collect one vitals sample. Each field degrades to null (or [] for lists) on
// error; this never throws, so a caller can await it inside a poll loop safely.
export async function collectVitals({ platform = process.platform, exec = defaultExec } = {}) {
  const [cpu, mem, disks, net, units] = await Promise.all([
    collectCpu(os.loadavg).catch(() => null),
    collectMem().catch(() => null),
    collectDisks().catch(() => []),
    collectNet().catch(() => null),
    listGarrisonUnits({ platform, exec }).catch(() => [])
  ]);
  return { ts: new Date().toISOString(), cpu, mem, disks, net, units };
}

// Pure parsing + labeling + severity for the Ports fitting.
//
// NO I/O lives here. Every function takes already-read strings/objects and
// returns plain data, so the test-suite (tests/ports-fitting.test.ts) imports
// these directly and the server (scripts/server.mjs) does the file/exec reads.

// ---------------------------------------------------------------------------
// Address helpers
// ---------------------------------------------------------------------------

// Strip an interface scope suffix (e.g. "127.0.0.53%lo" -> "127.0.0.53") and
// surrounding IPv6 brackets so classification works on the bare address.
export function bareAddress(address) {
  if (!address) return "";
  let a = String(address);
  if (a.startsWith("[") && a.endsWith("]")) a = a.slice(1, -1);
  const pct = a.indexOf("%");
  if (pct !== -1) a = a.slice(0, pct);
  return a;
}

// Split an "address:port" token into { address, port }. Handles:
//   IPv4:            127.0.0.1:27077 / 0.0.0.0:23702 / 10.0.0.4:8080
//   IPv4 wildcard:   *:21118
//   iface scope:     127.0.0.53%lo:53
//   IPv6 bracketed:  [::1]:631 / [::]:22 / [fd7a:115c::a52f]:443
// Port "*" (any) yields port: null. Returns null port when unparseable.
export function splitAddressPort(token) {
  if (!token) return { address: "", port: null };
  const t = String(token).trim();
  const bracket = t.match(/^\[(.+)\]:(\d+|\*)$/);
  if (bracket) {
    const port = bracket[2] === "*" ? null : Number(bracket[2]);
    return { address: bracket[1], port: Number.isFinite(port) ? port : null };
  }
  const idx = t.lastIndexOf(":");
  if (idx === -1) return { address: t, port: null };
  const address = t.slice(0, idx);
  const portStr = t.slice(idx + 1);
  if (portStr === "*") return { address, port: null };
  const port = Number(portStr);
  return { address, port: Number.isFinite(port) ? port : null };
}

// A bind is loopback when it can only be reached from the same host:
// 127.0.0.0/8, ::1, or the IPv4-mapped loopback ::ffff:127.x. Wildcard binds
// (0.0.0.0, ::, *) are reachable off-box, so they are NOT loopback.
export function isLoopback(address) {
  const bare = bareAddress(address);
  if (!bare) return false;
  if (bare === "::1") return true;
  if (bare === "0.0.0.0" || bare === "::" || bare === "*") return false;
  if (/^127\./.test(bare)) return true;
  if (/^::ffff:127\./i.test(bare)) return true;
  return false;
}

// A wildcard bind listens on every interface (0.0.0.0, ::, *).
export function isWildcard(address) {
  const bare = bareAddress(address);
  return bare === "0.0.0.0" || bare === "::" || bare === "*";
}

// Reachability severity for a bind:
//   "local"    loopback-only, safe
//   "exposed"  wildcard bind, reachable on every interface
//   "bound"    a specific non-loopback address (e.g. the tailnet IP)
export function severity(row) {
  if (row.loopback) return "local";
  if (row.wildcard) return "exposed";
  return "bound";
}

// ---------------------------------------------------------------------------
// `ss -tlnpH` parsing (Linux)
// ---------------------------------------------------------------------------
// Column layout (H = no header):
//   State Recv-Q Send-Q Local-Address:Port Peer-Address:Port [users:((...))]
// The process column can contain spaces (e.g. `next-server (v1`), so we anchor
// on the five fixed leading tokens and treat the remainder as the process blob.

// Parse a `users:(("cmd",pid=N,fd=M),...)` blob into a primary command + pid
// plus every pid seen (SO_REUSEPORT can list several). A command name may hold
// spaces/parens but never a double-quote, so [^"]* is a safe delimiter.
export function parseProcessField(field) {
  if (!field) return { command: null, pid: null, pids: [] };
  const procs = [];
  const re = /\("([^"]*)",pid=(\d+),fd=\d+\)/g;
  let m;
  while ((m = re.exec(field)) !== null) {
    procs.push({ command: m[1], pid: Number(m[2]) });
  }
  if (procs.length === 0) return { command: null, pid: null, pids: [] };
  return {
    command: procs[0].command,
    pid: procs[0].pid,
    pids: procs.map((p) => p.pid)
  };
}

// Parse one `ss -tlnpH` line into a normalized row, or null if it doesn't look
// like a listening socket line.
export function parseSsLine(line) {
  if (!line || !line.trim()) return null;
  const m = line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/);
  if (!m) return null;
  const { address, port } = splitAddressPort(m[4]);
  if (port == null) return null;
  const proc = parseProcessField((m[6] ?? "").trim());
  return {
    address,
    port,
    loopback: isLoopback(address),
    wildcard: isWildcard(address),
    command: proc.command,
    pid: proc.pid,
    pids: proc.pids
  };
}

export function parseSs(output) {
  const rows = [];
  for (const line of String(output ?? "").split("\n")) {
    const row = parseSsLine(line);
    if (row) rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// `lsof -iTCP -sTCP:LISTEN -P -n` parsing (macOS)
// ---------------------------------------------------------------------------
// Column layout:
//   COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
// NAME carries the address and a trailing "(LISTEN)". With -sTCP:LISTEN only
// listening sockets appear, but we still guard on the state.
export function parseLsofLine(line) {
  if (!line || !line.trim()) return null;
  if (line.startsWith("COMMAND")) return null;
  const parts = line.trim().split(/\s+/);
  if (parts.length < 9) return null;
  const command = parts[0];
  const pid = Number(parts[1]);
  if (!Number.isFinite(pid)) return null;
  const name = parts.slice(8).join(" ");
  const stateM = name.match(/\(([A-Z_]+)\)\s*$/);
  const state = stateM ? stateM[1] : null;
  if (state && state !== "LISTEN") return null;
  const addrPart = stateM ? name.slice(0, stateM.index).trim() : name.trim();
  const { address, port } = splitAddressPort(addrPart);
  if (port == null) return null;
  return {
    address,
    port,
    loopback: isLoopback(address),
    wildcard: isWildcard(address),
    command,
    pid,
    pids: [pid]
  };
}

export function parseLsof(output) {
  const rows = [];
  for (const line of String(output ?? "").split("\n")) {
    const row = parseLsofLine(line);
    if (row) rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Label indexes
// ---------------------------------------------------------------------------

// Build port -> fittingId from the ~/.garrison/ui-fittings/*.json status files.
export function buildStatusIndex(statusFiles) {
  const index = new Map();
  for (const sf of statusFiles ?? []) {
    if (!sf) continue;
    const port = Number(sf.port);
    if (!Number.isFinite(port) || !sf.fittingId) continue;
    index.set(port, sf.fittingId);
  }
  return index;
}

// ---------------------------------------------------------------------------
// Label resolution — order: ui-fitting status > pid/cmd.
// ---------------------------------------------------------------------------
export function resolveLabel(row, indexes = {}) {
  const statusIndex = indexes.statusIndex instanceof Map ? indexes.statusIndex : new Map();

  // (1) ui-fitting status files — port -> fittingId.
  const fittingId = statusIndex.get(row.port);
  if (fittingId) {
    return { source: "fitting", label: fittingId, detail: null };
  }
  // (2) owning pid + command line.
  if (row.command) {
    return {
      source: "process",
      label: row.command,
      detail: row.pid != null ? `pid ${row.pid}` : null
    };
  }
  return {
    source: "unknown",
    label: null,
    detail: row.pid != null ? `pid ${row.pid}` : null
  };
}

// Combine parsed rows with the label indexes into UI-ready records, sorted by
// port. Pure — the server passes already-built indexes in.
export function buildPortRows(parsedRows, indexes = {}) {
  return (parsedRows ?? [])
    .map((row) => {
      const label = resolveLabel(row, indexes);
      return {
        port: row.port,
        address: row.address,
        loopback: row.loopback,
        wildcard: row.wildcard,
        severity: severity(row),
        pid: row.pid ?? null,
        pids: row.pids ?? [],
        command: row.command ?? null,
        labelSource: label.source,
        label: label.label,
        labelDetail: label.detail
      };
    })
    .sort((a, b) => a.port - b.port || a.address.localeCompare(b.address));
}

// Every pid that currently owns a listening socket (used by the kill guard).
export function listeningPidSet(parsedRows) {
  const set = new Set();
  for (const row of parsedRows ?? []) {
    for (const pid of row.pids ?? []) {
      if (Number.isInteger(pid)) set.add(pid);
    }
    if (Number.isInteger(row.pid)) set.add(row.pid);
  }
  return set;
}

// ---------------------------------------------------------------------------
// Kill guard — refuse pid<=1, our own pid + parent, and any pid that does NOT
// currently hold a listening socket (per the last scan). Pure predicate.
// ---------------------------------------------------------------------------
export function killGuard(pid, ctx = {}) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 1) {
    return { allowed: false, reason: "refusing to signal pid <= 1" };
  }
  if (ctx.selfPid != null && n === Number(ctx.selfPid)) {
    return { allowed: false, reason: "refusing to signal the Ports server itself" };
  }
  if (ctx.parentPid != null && n === Number(ctx.parentPid)) {
    return { allowed: false, reason: "refusing to signal the Ports parent process" };
  }
  const set = ctx.listeningPids instanceof Set ? ctx.listeningPids : new Set(ctx.listeningPids ?? []);
  if (!set.has(n)) {
    return { allowed: false, reason: "pid does not currently hold a listening socket" };
  }
  return { allowed: true, reason: null };
}

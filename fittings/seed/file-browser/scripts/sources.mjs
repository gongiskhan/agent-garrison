// Where the file browser can browse.
//
// There are two kinds of source and the browser treats them identically:
//
//   local  - the scoped workspace root this fitting has always served, read/write.
//   remote - a machine the remote-shell runtime holds a transport to, read-only.
//            That is the project an agent is actually working in, which is the
//            whole point: you can now review the work instead of only reading a
//            report about it.
//
// PEER ADDRESS, NOT PORT LITERAL. The remote-shell fitting's port belongs to the
// composition and shifts per instance, so guessing it would pin one instance and
// silently talk to another's machine. This asks the shell (GARRISON_BASE_URL,
// projected by the runner) which URL that fitting is on, and caches the answer
// briefly so a browse does not become two round trips.

const DISCOVERY_TTL_MS = 30_000;

let cached = { at: 0, url: null };

function baseUrl(env) {
  const raw = String(env.GARRISON_BASE_URL || "").trim();
  return raw.replace(/\/+$/, "");
}

async function fetchJson(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`${res.status} from ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** The remote-shell fitting's own-port URL, or null when it is not running. */
export async function remoteShellUrl(env = process.env, { now = Date.now() } = {}) {
  const shell = baseUrl(env);
  if (!shell) return null;
  if (cached.url && now - cached.at < DISCOVERY_TTL_MS) return cached.url;
  try {
    const data = await fetchJson(`${shell}/api/fittings/views`);
    const view = (data.views ?? []).find((v) => v.fittingId === "remote-shell-runtime");
    const url = view?.url ? String(view.url).replace(/\/+$/, "") : null;
    cached = { at: now, url };
    return url;
  } catch {
    // A shell that is down is not an error here - the local source still works,
    // and the UI shows remote sources as unavailable rather than failing to load.
    return null;
  }
}

/** Test seam: forget the discovered peer address. */
export function resetSourceCache() {
  cached = { at: 0, url: null };
}

/**
 * Every source the browser can offer right now. The local one always exists; the
 * remote ones depend on the remote-shell fitting being up and having transports.
 */
export async function listSources(env = process.env, localRoot = "") {
  const sources = [
    {
      id: "local",
      kind: "local",
      label: "Garrison files",
      root: localRoot,
      writable: true,
      available: true
    }
  ];
  const shell = await remoteShellUrl(env);
  if (!shell) return sources;
  try {
    const data = await fetchJson(`${shell}/transports`);
    for (const t of data.transports ?? []) {
      sources.push({
        id: `remote:${t.name}`,
        kind: "remote",
        transport: t.name,
        label: t.label || t.name,
        root: t.cwd || "~",
        // Read-only by design: an agent is running in there, and editing under it
        // would race with work you cannot see.
        writable: false,
        available: true
      });
    }
  } catch {
    /* transports unreadable - offer local only, rather than a broken picker */
  }
  return sources;
}

/** Split a source id into its kind. */
export function parseSourceId(id) {
  const raw = String(id || "local");
  if (raw === "local") return { kind: "local" };
  const m = /^remote:(.+)$/.exec(raw);
  return m ? { kind: "remote", transport: m[1] } : { kind: "unknown", raw };
}

/** Proxy a directory listing for a remote source. */
export async function remoteList(transport, relPath, env = process.env) {
  const shell = await remoteShellUrl(env);
  if (!shell) throw new Error("the remote-shell fitting is not running, so remote sources are unavailable");
  const url = `${shell}/transports/${encodeURIComponent(transport)}/files?path=${encodeURIComponent(relPath || "")}`;
  const data = await fetchJson(url, 25_000);
  if (data.error) throw new Error(data.error);
  return data;
}

/** Proxy a file read for a remote source. */
export async function remoteRead(transport, relPath, env = process.env) {
  const shell = await remoteShellUrl(env);
  if (!shell) throw new Error("the remote-shell fitting is not running, so remote sources are unavailable");
  const url = `${shell}/transports/${encodeURIComponent(transport)}/file?path=${encodeURIComponent(relPath || "")}`;
  const data = await fetchJson(url, 35_000);
  if (data.error) throw new Error(data.error);
  return data;
}

// Read the remote machine's filesystem over the transport that is already open.
//
// WHY HERE. This fitting owns the ssh transport; nothing else should learn how to
// reach the remote. The file browser consumes this over HTTP and stays a pure UI
// over a source interface, so a second consumer costs nothing and no other fitting
// grows an ssh dependency.
//
// READ-ONLY, ON PURPOSE. The remote is somebody's working machine with an agent
// running in it. Browsing to review is the job; editing underneath a running agent
// would race with it and there is no honest merge story. Writes stay with the
// agent, in its own session, where you can see them happen.
//
// CONFINEMENT. Every path is resolved against the transport's declared `cwd` (the
// project the agent works in) and must stay inside it. The check happens on the
// REMOTE, after symlink resolution, because only the remote can answer where a
// link actually points - a local string check would be theatre.

import path from "node:path";
import { sshExec } from "./transports.mjs";

/** Largest file we will pull over a shell channel, in bytes. */
export const MAX_READ_BYTES = 2 * 1024 * 1024;

/** Entries beyond this are truncated rather than streamed into a JSON response. */
export const MAX_ENTRIES = 4000;

/**
 * Quote a value for POSIX sh. Single quotes with the close-reopen trick, which is
 * the only form with no escape sequences to get wrong.
 */
export function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * The remote root for a transport: its declared cwd, with a leading ~ left for the
 * remote shell to expand (it knows its own HOME; we do not).
 */
export function rootExpr(transport) {
  const cwd = transport.cwd || "~";
  return cwd.startsWith("~/") ? `"$HOME"/${shQuote(cwd.slice(2))}` : shQuote(cwd);
}

/**
 * Normalise a browser-supplied relative path. Rejects absolute paths and anything
 * that climbs out; the remote-side realpath check below is the real fence, this is
 * the cheap one that keeps obvious nonsense off the wire.
 */
export function normalizeRel(rel) {
  const raw = String(rel ?? "").trim();
  if (!raw || raw === "." || raw === "/") return "";
  if (raw.startsWith("/")) throw new Error("path must be relative to the project root");
  const normal = path.posix.normalize(raw);
  if (normal === ".." || normal.startsWith("../")) throw new Error("path escapes the project root");
  return normal.replace(/^\.\//, "").replace(/\/+$/, "");
}

/** Build `<root>/<rel>` as a shell expression. */
function targetExpr(transport, rel) {
  const root = rootExpr(transport);
  return rel ? `${root}/${shQuote(rel)}` : root;
}

/**
 * The confinement preamble: resolve the target and the root with realpath, and
 * refuse unless the target is the root or sits beneath it. Runs on the remote so a
 * symlink pointing outside the project is caught where the truth lives.
 */
function guarded(transport, rel, body) {
  return [
    `root=$(realpath ${rootExpr(transport)} 2>/dev/null)`,
    `target=$(realpath ${targetExpr(transport, rel)} 2>/dev/null)`,
    `[ -n "$root" ] || { echo "GARRISON_ERR project root does not exist" >&2; exit 3; }`,
    `[ -n "$target" ] || { echo "GARRISON_ERR no such path" >&2; exit 4; }`,
    `case "$target" in "$root"|"$root"/*) : ;; *) echo "GARRISON_ERR path escapes the project root" >&2; exit 5;; esac`,
    body
  ].join("\n");
}

function fail(result, fallback) {
  const marked = /GARRISON_ERR (.+)/.exec(result.stderr || "");
  const err = new Error(marked ? marked[1].trim() : (result.stderr || "").trim() || fallback);
  err.code = result.code;
  return err;
}

/**
 * List one directory. One `find -maxdepth 1` call emitting TSV - a per-entry stat
 * would be one ssh round trip each, which over a tunnel is the difference between
 * instant and unusable.
 */
export async function listRemoteDir(transport, rel, opts = {}) {
  const clean = normalizeRel(rel);
  const script = guarded(
    transport,
    clean,
    [
      `[ -d "$target" ] || { echo "GARRISON_ERR not a directory" >&2; exit 6; }`,
      `find "$target" -maxdepth 1 -mindepth 1 -printf '%y\\t%s\\t%T@\\t%f\\n' 2>/dev/null | head -n ${MAX_ENTRIES + 1}`
    ].join("\n")
  );
  const result = await sshExec(transport, script, { timeoutMs: opts.timeoutMs ?? 20_000 });
  if (result.code !== 0) throw fail(result, "could not list the directory");
  const lines = result.stdout.split("\n").filter(Boolean);
  const truncated = lines.length > MAX_ENTRIES;
  const entries = lines.slice(0, MAX_ENTRIES).map((line) => {
    const [type, size, mtime, ...rest] = line.split("\t");
    const name = rest.join("\t");
    return {
      name,
      path: clean ? `${clean}/${name}` : name,
      // find's %y: d directory, f regular, l symlink, and others we do not model.
      type: type === "d" ? "dir" : type === "l" ? "link" : "file",
      size: Number(size) || 0,
      modified: Number(mtime) ? new Date(Number(mtime) * 1000).toISOString() : null
    };
  });
  entries.sort((a, b) =>
    a.type === b.type || (a.type !== "dir" && b.type !== "dir")
      ? a.name.localeCompare(b.name)
      : a.type === "dir"
        ? -1
        : 1
  );
  return { path: clean, entries, truncated };
}

/**
 * Read one file. Base64 on the wire so a binary asset survives the shell channel
 * intact; the caller decides whether to decode it as text.
 */
export async function readRemoteFile(transport, rel, opts = {}) {
  const clean = normalizeRel(rel);
  if (!clean) throw new Error("a file path is required");
  const limit = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : MAX_READ_BYTES;
  const script = guarded(
    transport,
    clean,
    [
      `[ -f "$target" ] || { echo "GARRISON_ERR not a regular file" >&2; exit 7; }`,
      `size=$(stat -c%s "$target" 2>/dev/null || echo 0)`,
      `printf 'GARRISON_SIZE %s\\n' "$size"`,
      // Truncate rather than refuse: seeing the head of a huge log is useful, and a
      // flat refusal would make the browser useless for exactly the files people
      // most want to glance at. The caller is told it was cut.
      `head -c ${limit} "$target" | base64 -w0`
    ].join("\n")
  );
  const result = await sshExec(transport, script, { timeoutMs: opts.timeoutMs ?? 30_000 });
  if (result.code !== 0) throw fail(result, "could not read the file");
  const sizeLine = /GARRISON_SIZE (\d+)/.exec(result.stdout);
  const size = sizeLine ? Number(sizeLine[1]) : 0;
  const b64 = result.stdout.replace(/GARRISON_SIZE \d+\n?/, "").replace(/\s+/g, "");
  const buffer = Buffer.from(b64, "base64");
  return {
    path: clean,
    size,
    truncated: size > buffer.length,
    base64: buffer.toString("base64"),
    bytes: buffer.length
  };
}

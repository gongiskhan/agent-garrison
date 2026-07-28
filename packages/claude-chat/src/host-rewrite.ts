// Canonical host-aware URL + file-path helpers for rendered assistant text.
//
// The user is almost never on the box running Garrison - they reach it from
// another device over the HTTPS tailnet address. A reply that carries a
// machine-local loopback URL (`http://127.0.0.1:<port>/...`, e.g. a Kanban card
// link the gateway baked into the text) or a bare filesystem path (an uploaded
// attachment, a run artifact) is useless there: the loopback host resolves to
// the user's OWN device and a plain-http frame is mixed-content-blocked.
//
// `rewriteHostUrl` turns a loopback URL into one the CURRENT client can reach:
//   - client itself on loopback (local dev) -> unchanged (direct, fastest)
//   - the port is `tailscale serve`-mapped   -> the HTTPS tailnet URL (same
//     scheme, so no mixed content; serve proxies HTTP/WS/SSE), path/query/hash
//     preserved
//   - any other remote host                  -> best-effort rebind of the
//     loopback host to the page host, keeping scheme/port
// It returns "" when the page is HTTPS but the only available rebind is http://
// (mixed content, browser-blocked); callers render inert text + a hint.
//
// The file-path helpers turn absolute paths into same-origin `/file?path=` refs
// so an image renders inline and any other file becomes a real link (the origin
// inherits its own `tailscale serve` mapping, so no host logic is needed here).
//
// This file is PURE (no DOM, no imports) and COPIED per bundle boundary, since
// own-port fittings install independently and cannot import from src/ or each
// other (mirrors the existing tailnet-serve triplication). Keep the copies
// behaviourally identical:
//   src/lib/host-rewrite.ts, fittings/seed/kanban-loop/ui/host-rewrite.ts

export type ServeMap = Record<string, string>; // "<localPort>" -> "https://host:servePort"

export interface HostContext {
  hostname: string; // window.location.hostname
  protocol: string; // window.location.protocol ("https:" | "http:")
  serveMap: ServeMap; // localPort -> tailnet https URL (may be empty)
}

const LOOPBACK = /^(https?:\/\/)(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(?=[:/?#]|$)/i;

export function rewriteHostUrl(raw: string, ctx: HostContext): string {
  if (!raw || !LOOPBACK.test(raw)) return raw; // not a loopback URL: untouched
  const hostname = ctx?.hostname ?? "";
  const protocol = ctx?.protocol ?? "";
  const serveMap = ctx?.serveMap ?? {};
  // Client itself on loopback (local dev): the loopback URL is directly reachable.
  if (!hostname || hostname === "127.0.0.1" || hostname === "localhost") return raw;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  const base = serveMap[String(port)];
  if (base) {
    try {
      const b = new URL(base);
      u.protocol = b.protocol;
      u.host = b.host; // host carries the serve port
      return u.toString();
    } catch {
      // fall through to the host rebind
    }
  }
  // No serve mapping: rebind the loopback host to the page host, keep scheme/port.
  const rebound = raw.replace(LOOPBACK, `$1${hostname}`);
  if (protocol === "https:" && rebound.startsWith("http://")) return ""; // mixed content
  return rebound;
}

// --- File-path -> same-origin ref helpers -----------------------------------

const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg)$/i;

// A conservative absolute-path matcher: leading "/", at least one directory
// segment, a filename WITH an extension, and NO whitespace (uploaded names are
// safeFilename-normalised, so this never grabs trailing prose). Anchored for use
// as a marked inline tokenizer.
const ABS_PATH = /^\/(?:[\w.@+~-]+\/)+[\w.@+~-]+\.[A-Za-z0-9]{1,8}/;

// Only linkify paths that clearly point at a Garrison-served root (uploads / run
// artifacts / a .garrison tree) OR any image file. Anything else stays plain
// text, so we never emit a link that the /file endpoint would 403.
const KNOWN_ROOT = /(?:^|\/)\.garrison\/|\/uploads\/|\/runs\//;

export function isImagePath(p: string): boolean {
  return IMAGE_EXT.test(p);
}

function shouldLinkifyPath(p: string): boolean {
  return isImagePath(p) || KNOWN_ROOT.test(p);
}

// Same-origin ref that streams the file through the origin's `/file` endpoint.
export function fileHref(absPath: string): string {
  return `/file?path=${encodeURIComponent(absPath)}`;
}

function basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}

function escAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// HTML for an absolute path: an inline <img> for images, else a labelled link.
// Both target the same-origin /file endpoint.
export function filePathHtml(absPath: string): string {
  const href = escAttr(fileHref(absPath));
  if (isImagePath(absPath)) {
    return `<img src="${href}" alt="${escAttr(basename(absPath))}" loading="lazy" class="cc-inline-img" />`;
  }
  return `<a href="${href}" target="_blank" rel="noopener noreferrer">${escText(basename(absPath))}</a>`;
}

// A marked INLINE extension that turns qualifying absolute paths into the HTML
// above. Emits nothing (falls back to text) for paths outside a known root that
// aren't images, and - because marked hands fenced/inline code as separate
// tokens - never fires inside code. Loosely typed: marked's token types are
// version-specific.
export function filePathMarkedExtension(): any {
  return {
    name: "garrisonFilePath",
    level: "inline",
    start(src: string) {
      const idx = src.search(/\/(?:[\w.@+~-]+\/)+[\w.@+~-]+\.[A-Za-z0-9]{1,8}/);
      return idx < 0 ? undefined : idx;
    },
    tokenizer(src: string) {
      const m = ABS_PATH.exec(src);
      if (!m) return undefined;
      const path = m[0];
      if (!shouldLinkifyPath(path)) return undefined;
      return { type: "garrisonFilePath", raw: path, path };
    },
    renderer(token: { path: string }) {
      return filePathHtml(token.path);
    },
  };
}

import type { Marked } from "marked";
import { rewriteHostUrl, type HostContext, type ServeMap } from "./host-rewrite";

let serveMap: ServeMap = {};
let hostMapPromise: Promise<void> | null = null;

export function loadHostMap(): Promise<void> {
  if (!hostMapPromise) {
    hostMapPromise = fetch("/host-map")
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (payload?.map && typeof payload.map === "object") serveMap = payload.map as ServeMap;
      })
      .catch(() => {});
  }
  return hostMapPromise;
}

export function hostCtx(): HostContext {
  return {
    hostname: typeof window !== "undefined" ? window.location.hostname : "",
    protocol: typeof window !== "undefined" ? window.location.protocol : "",
    serveMap,
  };
}

export function escapeMarkdownHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeMarkdownAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isSafeHref(url: string): boolean {
  const value = url.trim();
  if (value === "") return false;
  if (/^(?:\/|#|\?|\.\/|\.\.\/)/.test(value)) return true;
  if (/^\/\//.test(value)) return true;
  return /^(?:https?:|mailto:|tel:)/i.test(value);
}

/** Install the security- and host-boundary rules shared by every Claude Chat
 * markdown surface. Callers may layer their own code-block renderer on top, but
 * links and raw HTML must always pass through this seam. */
export function installSafeMarkdownRenderer(
  marked: Marked,
  hostContext: () => HostContext = hostCtx
): void {
  marked.use({
    renderer: {
      html({ text }: { text: string }) {
        return escapeMarkdownHtml(text);
      },
      link(this: any, { href, title, tokens }: { href: string; title?: string | null; tokens: any[] }) {
        const text = this.parser.parseInline(tokens);
        const original = (href || "").trim();
        let url = href || "";
        const garrison = /^garrison:\/\/([^/]+)\/?(.*)$/.exec(url);
        if (garrison) {
          url = `/fitting/${garrison[1]}${garrison[2] ? `/${garrison[2]}` : ""}`;
        }
        if (!isSafeHref(url)) return text;
        if (/^https?:\/\//i.test(url)) {
          const reachable = rewriteHostUrl(url, hostContext());
          if (reachable === "") return `<span class="cc-unreachable">${text}</span>`;
          url = reachable;
        }
        const external = /^https?:\/\//i.test(url) || /^\/\//.test(url)
          ? ` target="_blank" rel="noopener noreferrer"`
          : "";
        const label = title ? ` title="${escapeMarkdownAttribute(title)}"` : "";
        // An AUTOLINK is its own label. Rewriting only the href left a loopback
        // address on screen: the click worked, but the text read as dead and
        // copied as dead - which is what a reader on any other device believes.
        // Only a label that IS the original url is replaced; a human-written
        // label is the author's words and stays untouched.
        const shown = text.trim();
        const body = shown === original || shown === escapeMarkdownHtml(original)
          ? escapeMarkdownHtml(url)
          : text;
        return `<a href="${escapeMarkdownAttribute(url)}"${label}${external}>${body}</a>`;
      },
    },
  });
}

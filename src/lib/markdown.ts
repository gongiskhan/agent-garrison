import { Marked } from "marked";
import { filePathMarkedExtension } from "./host-rewrite";

// Shared, safe Markdown renderer for produced documents / assistant replies.
// A PRIVATE Marked instance (never the global singleton) so configuring it can't
// affect an unrelated marked.parse() consumer. Content-agnostic:
//   1. garrison://<fitting-id>/<rest> cross-fitting links -> /fitting/<id>/<rest>
//      (UI-contract-v2), so a produced doc/artifact link renders as a real link.
//   2. http(s) links open in a new tab (rel=noopener noreferrer).
//   3. UNSAFE schemes (javascript:/data:/vbscript:/…) are NOT linkified — the
//      text is kept, the dangerous href dropped. RAW HTML is escaped (marked does
//      not sanitize). href/title are HTML-attribute-escaped.

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Allow only safe link targets; reject active-content schemes.
function isSafeHref(url: string): boolean {
  const u = url.trim();
  if (u === "") return false;
  if (/^(?:\/|#|\?|\.\/|\.\.\/)/.test(u)) return true; // relative / anchor / query
  if (/^\/\//.test(u)) return true; // protocol-relative //host
  return /^(?:https?:|mailto:|tel:)/i.test(u); // explicit safe schemes only
}

const md = new Marked();
// `as any` on the renderer: marked's token types are version-specific and the
// dynamic `this.parser` access doesn't satisfy the strict root tsconfig.
md.use({
  renderer: {
    html(token: any) {
      return escapeHtml(token.text);
    },
    link(token: any) {
      const self = this as any;
      const text = self.parser.parseInline(token.tokens);
      let url = token.href || "";
      const g = /^garrison:\/\/([^/]+)\/?(.*)$/.exec(url);
      if (g) url = `/fitting/${g[1]}${g[2] ? `/${g[2]}` : ""}`;
      if (!isSafeHref(url)) return text; // drop the href, keep the text
      const attrs =
        /^https?:\/\//i.test(url) || /^\/\//.test(url) ? ` target="_blank" rel="noopener noreferrer"` : "";
      const t = token.title ? ` title="${escapeAttr(token.title)}"` : "";
      return `<a href="${escapeAttr(url)}"${t}${attrs}>${text}</a>`;
    }
  } as any
});
// Render bare absolute filesystem paths (attachments, run artifacts) as inline
// images / same-origin /file links. Root-relative, so safe at SSR here (no
// client host needed); loopback-URL rewriting is a client concern handled by the
// live chat surfaces (ClaudeChat, kanban).
md.use({ extensions: [filePathMarkedExtension()] });

export function renderMarkdown(src: string): string {
  return md.parse(src) as string;
}

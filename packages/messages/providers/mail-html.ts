import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";

const MAX_HTML_BYTES = 5 * 1024 * 1024;
/** Message HTML is inert data. Remote images remain disabled until the user asks. */
export function sanitizeMailHtml(source: string, loadImages = false): { html: string; remoteImages: string[] } {
  if (Buffer.byteLength(source, "utf8") > MAX_HTML_BYTES) throw new Error("Mail HTML exceeds 5 MB");
  const window = new JSDOM("").window;
  try {
    const purify = createDOMPurify(window);
    const html = purify.sanitize(source, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ["script", "style", "form", "input", "button", "select", "textarea", "iframe", "object", "embed", "base", "link", "meta", "video", "audio", "source"],
      FORBID_ATTR: ["style", "srcset", "ping", "background", "action", "formaction"],
      ALLOW_DATA_ATTR: false
    });
    const container = window.document.createElement("div");
    container.innerHTML = html;
    const remoteImages: string[] = [];
    for (const image of container.querySelectorAll("img")) {
      const src = image.getAttribute("src") ?? "";
      if (/^https?:\/\//i.test(src)) {
        remoteImages.push(src);
        if (!loadImages) {
          image.removeAttribute("src");
          image.setAttribute("data-message-image", String(remoteImages.length - 1));
          image.setAttribute("alt", image.getAttribute("alt") || "Remote image");
        }
      } else if (!/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(src)) {
        image.removeAttribute("src");
      }
    }
    for (const link of container.querySelectorAll("a")) {
      const href = link.getAttribute("href") ?? "";
      if (!/^(?:https?:|mailto:)/i.test(href)) link.removeAttribute("href");
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    }
    return { html: container.innerHTML, remoteImages };
  } finally { window.close(); }
}

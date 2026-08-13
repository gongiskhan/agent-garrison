// Pure deep-link host resolution for the HUD's kanban card links — extracted from
// main.tsx so it can be unit-tested without importing the React bundle (which has
// import-time side effects). Mirrors src/components/fitting-views/browser-view-url
// #resolveViewUrl.

export type CardBoardInfo = {
  available?: boolean;
  boardUrl?: string;
  tailnetUrl?: string | null;
};

// Rebind a loopback URL's host to the given page host (LAN/http fallback),
// preserving scheme + port. Returns the origin only (no path).
export function rebindLoopback(rawUrl: string, host: string): string {
  try {
    const u = new URL(rawUrl);
    if (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "0.0.0.0") u.hostname = host;
    return u.origin;
  } catch { return rawUrl; }
}

// The browser-reachable deep-link to a specific card, picking the right host for
// where the page actually is: loopback on localhost, the HTTPS tailnet URL over
// Tailscale (avoids mixed content + unreachable loopback), else a best-effort host
// rebind. `here` is the page hostname (window.location.hostname), passed in so
// this stays pure and testable.
export function resolveKanbanCardUrl(
  k: CardBoardInfo | null | undefined,
  cardId: string,
  here: string
): string | null {
  if (!k?.available || !k.boardUrl || !cardId) return null;
  let base = k.boardUrl;
  if (here && here !== "127.0.0.1" && here !== "localhost") {
    let matched = false;
    if (k.tailnetUrl) {
      try { if (new URL(k.tailnetUrl).hostname === here) { base = k.tailnetUrl; matched = true; } } catch { /* rebind below */ }
    }
    if (!matched) base = rebindLoopback(k.boardUrl, here);
  }
  return `${base.replace(/\/+$/, "")}/?card=${encodeURIComponent(cardId)}`;
}

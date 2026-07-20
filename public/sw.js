// Minimal Garrison service worker.
// Purpose: satisfy Chrome's PWA install criteria (manifest + a fetch handler).
// Garrison is local-only — no offline caching, no network rewrites.
//
// IMPORTANT: do NOT blanket-call `event.respondWith(fetch(event.request))`.
// A controlled page's service worker sees EVERY request it makes, including
// cross-origin ones — and Garrison's own-port Fitting views are cross-origin by
// construction (a different port is a different origin: the shell is on :8777 /
// the tailnet root, each view on :80xx / :84xx). A cross-origin `navigate`
// request cannot be replayed through `fetch()`; it rejects with
// "TypeError: Failed to fetch", and because that rejection was handed to
// respondWith the browser turned it into a hard network error instead of just
// loading the frame:
//
//   The FetchEvent for "…/embed/browser-default" resulted in a network error
//   response: the promise was rejected.
//   sw.js:17 Uncaught (in promise) TypeError: Failed to fetch
//
// which is why embedded Fitting views (Browser, Drill) failed to open. Passing
// through by NOT calling respondWith leaves the browser's own, more capable
// default handling in place — strictly better than re-issuing the request
// ourselves, and the handler still exists so the PWA stays installable.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Anything not a plain same-origin GET — cross-origin (Fitting views on their
  // own ports), navigations, websocket/SSE upgrades, POSTs — falls through to
  // the browser's default handling untouched.
  if (request.method !== "GET" || request.mode === "navigate") return;

  let sameOrigin = false;
  try {
    sameOrigin = new URL(request.url).origin === self.location.origin;
  } catch {
    return; // unparseable URL — let the browser deal with it
  }
  if (!sameOrigin) return;

  // Same-origin GET: still network-only (Garrison is local; offline does not
  // apply), but the rejection is caught so a failed request can never surface
  // as an uncaught error from the worker.
  event.respondWith(fetch(request).catch(() => Response.error()));
});

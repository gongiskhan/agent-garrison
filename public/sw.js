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

// ---- Web Push ---------------------------------------------------------------
// Conversations (/talk) subscribe this worker through /api/push/subscribe; the
// payload shape is the one @garrison/talk's push routes send. On iOS this fires
// only for a Home Screen install, which is why a push that resolves without
// showNotification() is never allowed (it can cost the origin its permission).

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Garrison", body: event.data ? event.data.text() : "You have a new notification." };
  }
  const title = data.title || "Garrison";
  const actions = Array.isArray(data.actions)
    ? data.actions.slice(0, 2).map((a) => ({ action: a.action, title: a.title }))
    : [];
  const options = {
    body: data.body || "",
    icon: "/icons/node-192.png",
    badge: "/icons/node-192.png",
    // tag collapses repeats of the same subject instead of stacking them.
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    data: { link: data.link || "/talk", actions: data.actions || [] },
    actions
  };
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, options);
      // Tell any open page, so the UI can render an in-app toast rather than
      // relying on a system banner the OS often suppresses while focused.
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clients) {
        client.postMessage({ type: "garrison-notification", payload: data });
      }
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const chosen = (data.actions || []).find((a) => a.action === event.action);
  const target = (chosen && chosen.url) || data.link || "/talk";
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Focus an existing window rather than opening a duplicate PWA instance.
      for (const client of clients) {
        if ("focus" in client) {
          await client.focus();
          client.postMessage({ type: "garrison-notification-click", action: event.action || null, url: target });
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(target);
    })()
  );
});

// Chrome/Safari can rotate a subscription without the page being open; without
// this the server keeps pushing to an endpoint the browser has abandoned.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const res = await fetch("/api/push/key");
        const { publicKey } = await res.json();
        const sub = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: publicKey
        });
        await fetch("/api/push/subscribe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ subscription: sub.toJSON(), label: "resubscribed" })
        });
      } catch {}
    })()
  );
});

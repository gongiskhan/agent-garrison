# Brief: in-iframe browser devtools for a local-first dev panel

A research brief to hand to a deep-research session. The goal is to
find an approach (library, technique, or alternative tool) that lets
us inspect Network and Console activity for a running web app that we
embed in a side panel of our own UI.

## What we're building

**Agent Garrison** is a local-first web app (Next.js front-end + small
Node processes per "Fitting") that helps a solo developer compose and
run autonomous Claude Code setups. One of the Fittings is a
**terminal** (`terminal-armory-default`), an xterm.js UI talking to a
local PTY over WebSocket — basically a browser-based terminal.

Inside that terminal Fitting we just added a **split-app pane**. The
left half (1/3) is the xterm.js terminal; the right half (2/3) is an
`<iframe>` loading the developer's actual web app under construction
(a Next.js dev server, typically) at
`http://<tailscale-ip>:<app.port>`. Each terminal session has a `cwd`,
and the dev project at that cwd has an `app.port` file Claude Code
writes. The terminal Fitting reads it and points the iframe there.

This is *the* surface we use from a phone over Tailscale. We
frequently want to debug "the app didn't load" or "this fetch failed"
or "what did the console print" — exactly the things a normal browser
devtools panel shows.

## What we're trying to achieve

A panel attached to (or replacing) the iframe area that gives us:

- A **Network tab**: outgoing HTTP/fetch/XHR/WebSocket requests made
  by the embedded app, their status, timing, request/response
  headers, response body preview.
- A **Console**: `console.log/warn/error` output from the embedded
  app, plus uncaught exceptions and unhandled promise rejections.
- Nice-to-haves: an Elements/DOM inspector, a Source viewer with
  breakpoints, Storage (localStorage / cookies / IndexedDB) viewer,
  Performance / framerate.
- It must work **on iOS Safari** (the primary mobile target —
  Garrison is accessed from an iPad/iPhone over Tailscale to a Mac).
  Android Chrome second.
- It must work **on desktop Chrome / Safari** too without forcing the
  user to open the real browser devtools in a separate tab — that
  workflow already exists ("New tab" button) and we want a better one
  *inside the Garrison UI*.

We do **not** need:

- A multi-tab profiler, no real-time CPU/heap snapshots.
- Anything that requires installing a browser extension on the
  developer's phone.
- Anything that requires the user to wire devtools by USB to a
  laptop (the whole point is the iPad is the laptop).

## Constraints / context

1. **The embedded app is on a different origin** from the parent
   page. Both are on the same host (Tailscale IP of the dev Mac), but
   different ports (e.g. parent on `:7078` (the terminal Fitting),
   iframe on `:7777` (Next.js dev)). Same-origin policy → the parent
   page **cannot** read the iframe's `contentWindow.document`,
   intercept its fetches, or inject scripts via JS. We control both
   ports but they're served by different processes.

2. **We control the embedded app's source code** to a reasonable
   degree — it's the developer's own Next.js app at the active
   terminal session's `cwd`. Injecting a `<script>` tag into that
   app is feasible *if* we have a robust way to do it (e.g. via a
   Next.js plugin, a small `<script>` snippet the user pastes once,
   or by proxying the dev server). The developer is the same person
   running Garrison — there's no separation-of-concerns issue.

3. **We control the terminal Fitting** — the parent page hosting the
   iframe. It's React 18, esbuild-bundled, served from a small
   Node/HTTP server (see "Tech stack" below). We can serve new
   static assets from it freely, expose new HTTP/WebSocket endpoints
   on `:7078`, etc.

4. **Local-first, single user, no auth.** Everything is over
   Tailscale to the developer's own Mac. We are not worried about
   the security/UX downsides of "inject debug script into every page
   you load" because the only thing being injected into is the
   developer's own dev server. No production traffic, no other
   users.

5. **We do *not* want to require browser devtools**. iOS Safari can
   only get devtools by plugging into a Mac running Safari Web
   Inspector — we want a path that works standalone on the iPad.

6. The iframe is **unstyled** — no chrome around the content, just
   `<iframe src=appUrl style="border:0; width:100%; height:100%">`.
   We're happy to add chrome (a tab bar, an "Inspect" toggle) but the
   iframe content itself should render as the app does.

## What we already considered and rejected (or want a second opinion on)

- **`window.open` + browser-native devtools** in a new tab. This is
  the current fallback. Doesn't solve iOS — Safari Web Inspector
  needs a Mac with USB.

- **Eruda** (https://github.com/liriliri/eruda). A popular in-page
  mobile devtools console. Drops in via a `<script>` tag and adds a
  floating panel with Console, Network (via fetch/XHR monkey patch),
  Elements, Resources, Info. The problem in our setup: Eruda runs
  inside the *iframe's* page, not the parent — so we need to inject
  it into the embedded app, not just load it in the terminal
  Fitting's HTML. That means either editing the user's app, adding a
  plugin to their Next.js config, or proxying.

- **vConsole** (https://github.com/Tencent/vConsole). Same shape as
  Eruda. Same injection problem.

- **Proxying the embedded dev server through our Fitting and
  injecting Eruda/vConsole into the HTML response.** Conceptually
  works. Worries: Next.js dev mode uses HMR over WebSocket, source
  maps, ESM imports with absolute URLs, server-side rendering — a
  naive HTML rewrite proxy will break a lot. Is there a battle-tested
  library that already does "proxy a dev server and inject a script"
  for exactly this use case?

- **Service Worker in the parent origin** intercepting fetches. The
  iframe's fetches don't go through the parent's service worker —
  service workers are scoped per origin, and the iframe is a
  different origin. Doesn't help.

- **`window.postMessage` API between parent and iframe.** Works
  *only* if the iframe cooperates (i.e. the embedded app calls
  `parent.postMessage(...)`). Could be the cleanest path: a tiny
  client we inject into the user's app sends every fetch + console
  entry via `postMessage` to the parent, which renders a devtools
  panel. Standard pattern? Existing library that does this?

- **A real embedded browser engine** — something like an Electron
  `<webview>`, a CEF (Chromium Embedded Framework) instance, or a
  WebView2/WKWebView with devtools enabled. We're not in Electron;
  we're a web app. But maybe there's a "browser-in-the-page" that
  ships its own JS-runtime + devtools (very unlikely on mobile but
  worth checking).

- **Chrome DevTools Frontend as a library**
  (https://chromedevtools.github.io/devtools-frontend/). It's the
  actual DevTools UI, runnable standalone. Connects to a remote
  debugging target via the Chrome DevTools Protocol (CDP). Can we
  point it at our embedded iframe? Probably needs the *browser* to
  expose CDP, which mobile Safari does not. But maybe in some hybrid
  setup it works.

## Tech stack we're using

Parent page (the terminal Fitting hosting the iframe):

- React 18 + TypeScript, bundled with esbuild (single bundle file).
- Plain Node 20 HTTP server (`node:http`) serving the bundle +
  exposing JSON endpoints (`/sessions`, `/terminals`, `/projects`,
  `/tailscale-ip`, `/app-port`) and a WebSocket at `/io` for PTY I/O.
- xterm.js for the terminal.
- No build system beyond esbuild. No framework on the server side.
- Runs at `http://127.0.0.1:7078` (rewritten to the host's Tailscale
  IP at link-build time so phones can reach it).

Iframe target (the embedded app under development):

- The developer's own project. Usually **Next.js dev mode** (`next
  dev`) on a port read from a file `app.port` in the project
  directory. Sometimes plain Vite or a static dev server. We don't
  control which framework — we control the convention (`app.port`,
  optional `backend.port`).
- Runs on the same host as the parent, different port.

Host:

- macOS, exposed to the developer's iPad over Tailscale (CGNAT
  100.x.y.z address). No real internet domain, no TLS. Everything is
  HTTP over Tailscale.

Browsers we care about:

- **iOS Safari** on iPad / iPhone (primary).
- Desktop Chrome and Safari (secondary).

## Code shape of the iframe area (for context)

```tsx
<div ref={splitWrapRef} className="split-wrap split-open">
  <div className="term-wrap" style={{flex: `0 0 calc(33% - 3px)`}}>
    {/* xterm.js terminal panes */}
  </div>
  <div className="split-divider" onPointerDown={...} />
  <div className="app-pane" style={{flex: `0 0 calc(67% - 3px)`}}>
    <div className="app-pane-header">
      <code>{appUrl}</code>
      <button onClick={refreshIframe}>Refresh</button>
      <button onClick={openAppInNewTab}>New tab</button>
      {/* place for a future "Inspect" / "DevTools" toggle */}
    </div>
    <iframe key={iframeNonce} className="app-iframe" src={appUrl} />
  </div>
</div>
```

`appUrl` is `http://<tailscale-ip>:<port-from-app.port-file>`.

## What we want from the research

1. **The best practical approach** to get Network + Console (at
   minimum) for the embedded app, given the constraints. Concrete
   library/tool recommendation if one exists.

2. **A working pattern for the proxy-and-inject approach** if that's
   the recommendation — what proxies handle Next.js dev mode
   correctly (HMR WebSocket + source maps + ESM), is there an
   off-the-shelf "inject Eruda into any served HTML" middleware?

3. **A working pattern for the postMessage approach** if that's the
   recommendation — is there an existing "remote devtools over
   postMessage" library, or do we roll it ourselves with a tiny
   `fetch`-wrapper + `console`-patch shim?

4. **Surprises we missed.** Maybe there's an embeddable browser
   widget, a Capacitor/Tauri-style trick that applies even though
   we're a plain web app, an alternative to Tailscale that bundles a
   devtools relay, etc. Honest take welcome — including "give up on
   doing this in-page on iOS, use *X* instead."

Limit length: a brief recommendation per option (pros / cons / how it
would integrate with the code shape above), then a final ranked
suggestion.

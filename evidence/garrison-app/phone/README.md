# Phone check: "safe areas are not taken into account" (2026-09-02)

The first TestFlight install on the iPhone showed the dashboard painted under
the status bar / Dynamic Island. Diagnosis and evidence below.

## What the shell does

- `src/app/layout.tsx` `generateViewport()` emits `viewport-fit=cover`.
- `src/app/globals.css` defines `--shell-safe-top: env(safe-area-inset-top)` and
  pads `.crumbs` (the first line of every non-talk page), `.side-rail`,
  `.sidebar` and the fixed `.composition-creator` with it;
  `packages/talk/ui/styles.css` reads the env() insets itself.
- The app keeps Capacitor's `ios.contentInset: "never"`
  (`GarrisonBridgeViewController.instanceDescriptor`), so the page owns its
  insets. Capacitor 8 added `SystemBars.insetsHandling` in
  `capacitor.config.json`, but that option is Android-only; on iOS the
  mechanism is still contentInset + viewport-fit + env().

## Simulator against this node (iPhone 17 Pro, iOS 26.2, build of 57129034)

`sim-macbook-pro-node-talk.png` (launch landing `/talk`) and
`sim-macbook-pro-node-home.png` (`/`, via the DEBUG `GARRISON_OPEN_PATH` lane)
against `https://goncalos-macbook-pro.tail31efa.ts.net`: the rail toggle, the
Conversations header, the `Garrison` crumb line and the `+ New` control all
clear the island; the composer clears the home indicator.

## What the phone was looking at

The mesh peers were still serving the pre-plan shell. Checked 2026-09-02 15:25Z:

```
dev-madrid            data-build-sha="af213250"  <meta name="viewport" content="width=device-width, initial-scale=1"/>
goncalos-mac-mini-1   data-build-sha="2bb381d8"  <meta name="viewport" content="width=device-width, initial-scale=1"/>
goncalos-macbook-air  (unreachable)
goncalos-macbook-pro  data-build-sha="cb9c9fbf"  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
```

Without `viewport-fit=cover` a `contentInset: never` web view lays the page out
under the status bar and `env(safe-area-inset-*)` reads 0px, which is exactly
the screenshot. Nothing in the app or in this node's shell changed for this
check; the fix for a phone pointed at a peer is that peer's `npm run
node:redeploy` from a converged `main`.

## Peers converged and redeployed (2026-09-02 18:30Z)

`main` was fast-forwarded to this node's work (`ae135cf7`), dev-madrid's
uncommitted card-id hardening landed as `e164f9f9` and was merged
(`d88a54cb`, one content conflict in `services/state/src/store.mjs` resolved
to the exported `isSafeCardId` version), and both reachable peers redeployed
from it. Re-checked over the tailnet:

```
dev-madrid            data-build-sha="d88a54cb"  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>  /talk 200
goncalos-mac-mini-1   data-build-sha="ae135cf7"  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>  /talk 200
goncalos-macbook-air  (offline; still on its pre-plan build until its own redeploy)
goncalos-macbook-pro  data-build-sha="cb9c9fbf"  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>  /talk 200
```

The mini's first `up` failed on `vault-git-sync` verify: its Obsidian vault
had been in `conflict` since 2026-08-31 (16 local sync commits vs 155
upstream, one content conflict in a mirrored memory note whose upstream
version was a superset). Resolved with a merge commit, pushed, sync re-run
(`nochange`), then `up` passed. Not an app issue; recorded so the next person
does not chase it.

## Second phone check: "not adjusting well to mobile" (2026-09-02 19:30 local)

The phone (16 Pro Max, 440x956, pointed at dev-madrid, thread
`morning-briefing`) showed `+ New` and the Raw toggle cut at the right edge
and the composer row cut at the bottom, with the left and top edges correct.
The same thread from the same node in Playwright WebKit at 440x956
(`webkit-madrid-morning-briefing-440.png`) fits, as does the 17 Pro Max
simulator against this node.

Measured on the phone shot against the WebKit shot (pt): rail 55 / 52, thread
chip 114 / 109, search box 257 / 242, `+ New` left edge 378 / 354, title
run 274 / 253 px. One ratio, 1.066 = 16/15: the WKWebView focus zoom on a
15px input with no `maximum-scale` in the viewport meta, which persists after
blur and widens the layout viewport past the screen. Decision D45: the shell
viewport now carries `maximum-scale=1, user-scalable=no`, and the talk inputs
are 16px under 600px. Verified served:

```
goncalos-macbook-pro  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover, user-scalable=no"/>
```

`sim-17promax-talk-after-d45.png` (17 Pro Max simulator, this node,
`/talk/brief-demo-view`): the Brief bar clears the island (it carries the top
inset now, the head under it no longer double-pads), REC sits in the composer
between the mic and the attach control, the composer clears the home
indicator. The focus zoom itself cannot be driven from `simctl` (no tap); the
cap is the documented WKWebView behaviour Ionic's default viewport relies on.

Voice and settings, for the record: the composer's mic is the streaming voice
lane and REC is the native capture (both were in the phone's cut-off bottom
row); the "settings" page is Capture at `/capture` (D34), listed in the
sidebar's Command group only inside the app (expand the rail, open Command).

## Third phone check: "make the menu a sliding menu, add a header" (2026-09-02 22:00 local)

Decision D46. Under 720px the shell drops the rail for an app bar and a
sliding drawer; Conversations and the embedded views fold under the bar; the
Kanban Loop view gains a phone layout of its own. Measured in Playwright
WebKit against this node after `node:reload`:

| shot | viewport | what it shows |
|---|---|---|
| `webkit-390-home-appbar.png` | 390x844 | app bar 48px: menu 44x44 at x 4, title + node name, `+ New` in the bar's flow (x 312); document width 390 = viewport (was 452 before, 400 with the session-log domain strip unwrapped) |
| `webkit-390-home-menu-open.png` | 390x844 | the drawer at 316px over a scrim: brand, node picker, Pinned, Command, Fittings, composition footer |
| `webkit-390-talk-thread.png` | 390x844 | `/talk/g5-live-mtk3hh1n`: one conversation row (name, search), Threads button in the bar, composer y 781 h 63 = bottom edge 844 (it was at 829, below the screen, while `.wc-shell` kept the skin's `100dvh`) |
| `webkit-390-talk-threads-drawer.png` | 390x844 | Threads button pressed: `.wc-sidebar` x 0 y 48, under the app bar |
| `webkit-390-talk-brief.png` | 390x844 | `/talk/brief-demo-view`: the Brief button sits in the conversation row instead of a 61px bar of its own |
| `webkit-440-embed-kanban.png` | 440x956 | `/embed/kanban-loop`: Back, "Kanban Board", menu in the bar; the fitting's phone layout below (column strip, one column with the next peeking, thumb-sized card actions) |

| `webkit-390-kanban-overflow.png` | 390x844 | the fitting alone on :8089: the topbar's overflow menu (History, Export, Import) over the column strip |
| `webkit-390-kanban-card-sheet.png` | 390x844 | a card opened from the carousel: full-height sheet, 44px close, chips wrapping, Raw log and Terminal side by side |

`/compose` at 390: document width 390. Every shot is the served prod build
(`.next-prod`), not the dev server.

Peers converged and reloaded at 559f6e65 (2026-09-03 00:10 local): dev-madrid
and the mini took `git merge --ff-only origin/main` (their build-output
`kanban-loop/dist` stashed first) and `npm run node:reload`.
`webkit-440-madrid-embed-kanban.png` is `/embed/kanban-loop` on dev-madrid
over the tailnet at 440x956: app bar with Back and "DEV-MADRID", the fitting's
phone layout below; `/talk/morning-briefing` there measures composer y 893
h 63 in a 956 viewport, document width 440.

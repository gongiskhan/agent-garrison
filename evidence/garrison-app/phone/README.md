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

## Fourth phone check: "conversations should not open in a new window; the past-conversations icon leads the header" (2026-09-03)

Decision D47. Measured in Playwright WebKit against this node's prod build
after `node:reload`:

| shot | viewport | what it shows |
|---|---|---|
| `webkit-390-talk-row-toggle.png` | 390x844 | `/talk/companion-reports`: the app bar carries no Threads action; the conversation row starts with the past-conversations toggle (`.wc-threads-toggle` x 10, 36x36), then the name, then the search; no floating toggle over the messages |
| `webkit-390-talk-row-toggle-open.png` | 390x844 | the toggle pressed: the thread drawer at x 0 under the app bar |
| `webkit-390-talk-remote-open.json` | 390x844 | tapping the dev-madrid "Morning Briefing" row: `before` is this node's conversation, `after` is `https://dev-madrid.tail31efa.ts.net/talk/morning-briefing`, `popups: 0`, `pages: 1` - the same window navigated, nothing opened |

At 800px the in-row toggle is present (the skin's overlay breakpoint is
899px); at 1280px it is hidden and the rail is always visible. In the app the
same tap becomes a native node switch carrying `/talk/<id>` (needs the
TestFlight build with `GarrisonNode.select(path)`); the simulator and the
phone are the operator's.

## Fifth phone check: "Conversations are opening in a new window. They should not" (2026-09-03)

Decision D48. D47 kept the tap in the same window but still navigated the
top window to the other node's origin, which a phone treats as leaving: a
Safari hand-off in the Garrison app (Capacitor opens any off-server top-level
load externally; sub-frame loads are allowed), a scope exit on a Home Screen
install. Now a row from another node opens `/mesh/talk/<node>/<id>` on THIS
node, which frames the conversation from its home node's chromeless
`/frame/talk/<id>`; a row tapped inside that frame posts
`garrison:open-conversation` to the parent, which routes it on its own origin.
Measured in Playwright WebKit against this node's prod build after
`node:reload` at `8b543503`, with dev-madrid and the mini reloaded on the same
commit:

| shot | viewport | what it shows |
|---|---|---|
| `webkit-390-mesh-talk-framed.png` | 390x844 | `/mesh/talk/dev-madrid/kanban-board-review` on this node: app bar (Back, "Conversations on dev-madrid", `+ New`, menu) at 0,0 390x48; the `.embed-view` iframe at 0,48 390x796 holds `https://dev-madrid.tail31efa.ts.net/frame/talk/kanban-board-review`, whose shell is `app-shell shell-frame shell-phone` with no app bar and no sidebar: the conversation row (toggle x 10 36x36, name, search) at y 0 and the composer at y 733 h 63 = the pane's bottom edge |
| `webkit-390-mesh-talk-hop-mini.png` | 390x844 | inside dev-madrid's frame, the thread list opened and a mini row tapped: the top window moved to `/mesh/talk/goncalos-mac-mini-1/companion-reports` on this node and the frame now loads the mini's `/frame/talk/companion-reports` |
| `webkit-1280-mesh-talk-framed.png` | 1280x800 | the same page on a desktop viewport: this node's sidebar at the left, the frame at 260,0 1020x800 with the peer's chromeless conversation (`app-shell shell-frame`, no bar, no side) |
| `webkit-390-mesh-talk-open.json` | 390x844 | three taps, each `popups` empty and `pages` 1: a dev-madrid row from `/talk` on this node lands on `/mesh/talk/dev-madrid/kanban-board-review`; a mini row tapped inside that frame lands on `/mesh/talk/goncalos-mac-mini-1/companion-reports` with the frame on the mini; a row this node owns, tapped inside the frame, lands on the local `/talk/g5-live-mtk3hh1n` with no frame |

`/api/mesh-threads` on this node, dev-madrid and the mini all emit local
`/mesh/talk/<node>/<id>` rows; `/frame/talk/<id>` answers 200 on both peers.
"+ New" on a peer goes to `/mesh/talk/<node>/?new=1`, which Next redirects
(308) to `/mesh/talk/<node>?new=1` keeping the query. The record button is
absent inside a framed conversation (no native bridge in a cross-origin
frame; follow-up). No app change: the fix is in the shell, any TestFlight
build shows it against a node on this commit; the Air still runs the pre-plan
code and its rows will frame nothing until its own redeploy.

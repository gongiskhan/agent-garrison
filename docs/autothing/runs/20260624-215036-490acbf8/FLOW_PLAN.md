# Flow Plan — Dev-Env Fully Responsive + Browser Viewport Selector

Run: `20260624-215036-490acbf8` · project: `garrison-dev-env-responsive`

Make the Garrison **dev-env Fitting** fully responsive and add a device-viewport
tester to its browser pane. Two operator asks:

1. **Responsive panes → tabs.** On narrow screens the side-by-side panes (Claude,
   Shell, Browser) collapse into a switchable tab/segmented switcher — *including
   the browser pane* (today it is hidden on mobile). Desktop keeps the resizable split.
2. **Browser viewport selector.** The browser pane gets a 3-way device-size selector —
   **mobile / tablet / desktop**. Mobile & tablet render the embedded app at a FIXED
   device width inside a centered, scrollable frame (it does *not* fluid-fit the pane —
   "does not adjust to browser size"); desktop = fluid full-pane. Usable on a desktop
   dev-env too, as a "test across device sizes" feature. "Lets have the 3."

Browser-side React only (`fittings/seed/dev-env/ui/**`). No server/runner changes.
Build: `node ui/build.mjs`. Own-port server: `scripts/server.mjs` (port 7086).

## Verify-first resolutions (decided — do not re-investigate, do not ask)
- **Collapse breakpoint** = the existing `MOBILE_QUERY` `(max-width: 720px)` (`useIsMobile`).
  At/below it the panes are tabs; above it the desktop split + dividers are unchanged.
  720px covers phones and small/portrait tablets — no new breakpoint churn. "Fully
  responsive" = the whole shell (header already flex-wraps) usable down to ~360px.
- **Mobile tab state**: extend `mobilePane` from `"claude" | "shell"` to
  `"claude" | "shell" | "browser"`. The header segmented control becomes 3-way on mobile.
- **Keep panes mounted, toggle `display`** (the existing pattern) rather than conditional
  unmount — preserves the Claude/shell PTYs and the browser iframe + its postMessage
  `attach` handshake when switching tabs. The browser pane must now render on mobile
  (remove the `!isMobile` gate on mounting; gate *visibility* by the active mobile tab).
- **Browser pane availability on mobile**: show the Browser tab whenever the pane would
  be available on desktop (app.port detected or user pinned/typed a URL). When no target,
  the Browser tab still renders its existing "No app.port — type a URL" empty state.
- **Viewport selector**: options `desktop | tablet | mobile`, default `desktop`. Widths:
  **mobile 390px**, **tablet 820px**, **desktop = fluid 100%**. Non-desktop wraps the
  iframe in a centered device frame: fixed width, fills available height, container
  `overflow:auto` so it scrolls when the device exceeds the pane. Persisted GLOBAL to
  `localStorage["garrison.devenv.deviceViewport"]` (follows the `garrison.devenv.*`
  convention; try/catch like the others). Applies in BOTH the desktop split and the
  mobile Browser tab.
- **Selector placement**: a `.segmented` control in `.app-pane-header`, after the URL
  input, before DevTools (mirrors the existing claude-view segmented pattern).
- **No iframe src change** for the selector — pure container CSS. The sticky src +
  `iframeNonce` remount + attach handshake keep working unchanged.

## Slices

| # | Slice ID | Title | Kind | Area / owns | Group | Status |
|---|----------|-------|------|-------------|-------|--------|
| 1 | responsive-panes | Panes collapse to a 3-way tab switcher on narrow screens (incl. browser) | ui | `fittings/seed/dev-env/ui/main.tsx`, `fittings/seed/dev-env/ui/styles.css` (layout/tab rules) | S0 | passed |
| 2 | browser-viewport-selector | Mobile/tablet/desktop device-size selector framing the embedded app | ui | `fittings/seed/dev-env/ui/browser-pane.tsx`, `fittings/seed/dev-env/ui/styles.css` (device-frame/segmented rules) | S1 (after S0) | passed |

**Parallel vs serial: SERIAL.** Both slices edit `styles.css`, and slice 2's device
frame must work inside slice 1's new mobile Browser tab. One dev-serve / one bundle /
one recorder shared. No parallel fan-out for a 2-slice coupled UI change.

Status legend: pending | in_progress | passed | blocked. Mirror of each
`slices/<id>/gate-status.json`.

## Acceptance (testable through the UI; drive the built dev-env at fixed viewport widths)

Evidence/e2e: build (`node ui/build.mjs`), serve `dist/` via the own-port server (or a
static serve), drive with Playwright at widths **390 (mobile)**, **820 (tablet)**,
**1400 (desktop)** with ≥1 session present. Assertions target DOM/layout/computed style —
no live Browser Fitting target required (the empty-state container is framed the same).

- **responsive-panes**
  - At **1400px**: the workspace shows the side-by-side split — `.terminals-col`, a
    `.split-divider`, and the browser pane visible together; the desktop resize dividers
    are present and functional (split unchanged from today).
  - At **390px / 820px**: a **3-way segmented switcher** (Claude · Shell · Browser) is
    present; exactly one pane is visible at a time; selecting **Browser** shows the
    browser pane (its iframe/empty-state) full-width — proving the browser pane now
    renders on mobile (regression of the old "hidden on mobile" behavior).
  - Switching tabs does not unmount/recreate the Claude/shell PTYs or the browser iframe
    (display-toggle, not remount).
  - No horizontal page overflow at 360–390px; header wraps; controls reachable.
- **browser-viewport-selector**
  - The browser pane toolbar has a 3-way **device selector** (Desktop · Tablet · Mobile).
  - **Mobile** → iframe (or its frame container) computed width ≈ **390px**, centered,
    with a device frame; **Tablet** → ≈ **820px**; **Desktop** → fluid (fills pane,
    width ≫ 820 at 1400px viewport).
  - When the device width exceeds the pane, the frame container scrolls (no clipping,
    no layout break).
  - Choice persists across reload (localStorage `garrison.devenv.deviceViewport`).
  - Works both in the desktop split and inside the mobile Browser tab.

## Critical files
- `fittings/seed/dev-env/ui/main.tsx` — App layout, `SessionWorkspace`, `useIsMobile`,
  `mobilePane` state + header segmented control, `browserVisible`/mount gating. (slice 1)
- `fittings/seed/dev-env/ui/styles.css` — `@media (max-width:720px)` block, `.workspace`/
  `.terminals-col`/`.app-pane` layout, `.segmented`; add tab + device-frame rules. (both)
- `fittings/seed/dev-env/ui/browser-pane.tsx` — toolbar `.app-pane-header`, the
  `<iframe className="app-iframe">`, new device-viewport state + frame wrapper. (slice 2)
- `fittings/seed/dev-env/ui/build.mjs` — esbuild bundler; run after edits. (build)
- `docs/architecture.md` — surface-wiring + host-config IO doctrine for Implement context.

## Notes for Implement
- Match existing CSS-var tokens (`--accent`, `--border`, `--bg-2`, etc.); reuse the
  `.segmented` button styling already in `styles.css`.
- Read/write localStorage inside try/catch (cross-origin iframe safety), like siblings.
- The header already flex-wraps at the breakpoint; the new 3-way mobile switch replaces
  the current `Claude | Shell` toggle (extend it, don't add a second control).

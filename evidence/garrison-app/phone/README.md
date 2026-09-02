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

The mesh peers still serve the pre-plan shell. Checked 2026-09-02 15:25Z:

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
node:redeploy` from a converged `main` (HANDOFF-garrison-app.md, section 2).

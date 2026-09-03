# G6: tether infrastructure - code, tests, live deploy (csg itself still locked out)

Everything in this note is unit-tested and live-deployed on dev-madrid; none of it has run against a
real tether yet, because csg (F-004) is not reachable. It is written to be exercised the moment csg is
back and the composition's csg transport gains a `tether` block (not done yet - deliberately deferred,
see "What's still not done" below).

## What was built

- **`fittings/seed/remote-shell-runtime/lib/tether.mjs` (`TetherManager`)** - one `ssh -N -o
  ExitOnForwardFailure=yes -R ... -L ...` child per tethered transport. `ensure()` brings it up and
  proves it with evidence from BOTH directions: every `-L` forward via `probeRoundTrip` (a real round
  trip, not a bare accept - the same discipline `forwards.mjs` already uses), and the `-R` state leg via
  a real `curl` run ON THE REMOTE through `exec` (a live local listener on the `-R` port proves nothing
  about whether the remote can actually reach back through it). `tick()` on a 20s timer retires and
  respawns only after TWO consecutive misses, with a 2s/60s crash-loop backoff that resets after 60s
  stable. `onUp` (run once per down->up transition, never on every healthy tick) fires the `params.onUp`
  command via `bash -lc`, and also writes `$GARRISON_HOME/remote-shell/tether.json` (the file
  `tailnet-serve-tether.mjs` reads). `tetherArmed()` gates every call on `GARRISON_NODE_NAME ===
  tether.owner` - a tether transport is inert everywhere except its declared owner.
- **`normalizeTether` in `transports.mjs`** - validates a `tether` config block: owner+node required,
  every forward needs a `localPort` (dropped with a warning otherwise), a `publish.servePort` in the
  reserved 8400-8499 band or the fixed infra ports (443/8443-8445/8860) is refused (not published, not a
  hard failure). `via.devtunnel.pushHostToken` added (default true, unchanged behaviour) - a tethered
  node's VS Code Remote Tunnel sets it `false` so `host-credential.mjs`'s minted-token push is skipped
  (that tunnel manages its own auth; Garrison pushing a token onto it would fight VS Code, not help it).
- **`GET /tether` + `POST /tether/:name/repair`** in `server.mjs`, mirroring the existing `/tunnels`
  routes exactly. At boot, every transport with a `tether` block gets `tether.ensure()` +
  `tether.startTicking()` called unconditionally - `tetherArmed()` makes that safe on every node that is
  NOT the owner (a quick no-op), so the loop needs no special-casing per node.
- **Mesh identity for a node with no tailnet interface of its own** (csg): `node.json` gains
  `tethered`/`tetherHost`/`appOrigin`/`shellOrigin` (the latter two https-only, anything else silently
  null - never mixed content on the always-https shell). `nodeAppOrigin`/`nodePageUrl`/`sameNodeOrigin`
  (`node-switch.ts`), `peerAppBase` (`peer-proxy.ts`), and the roster (`node-row.ts`, reading
  `health.node.appOrigin` - no state-service schema change, `hello()` already stores the whole self
  body) all now prefer a node's own `appOrigin` over deriving `https://<tailnetHost>`, falling back
  exactly as before when it is absent. `mesh-threads.mjs`'s peer-listing skip condition updated so a
  tethered peer with an `appOrigin` but no `tailnetHost` is not dropped.
- **`local.yml unstation: string[]`** (`compositions.ts`) - applied AFTER the config merge, refuses
  `orchestrator`/`http-gateway`/`scheduler` (logged once, not per-read), silently no-ops on an unknown
  id. This is what will let csg's `local.yml` drop channels/automations/memory-sync/etc that make no
  sense to run twice.
- **`scripts/tailnet-serve-tether.mjs`** (new) + **`scripts/lib/tailnet-serve-cli.mjs`** (the
  `tailscale`/`tailscaleServeWrite`/`serveStatus`/`existingMappings`/`enrich` plumbing extracted out of
  `tailnet-serve-views.mjs` so both scripts share one implementation). Reads a tether's
  localPort/servePort pairs from `tether.json` and publishes them via `tailscale serve` on THIS
  (owner) machine's own tailnet identity - a tethered node has none of its own to publish from.
  `tailnet-serve-views.mjs` now exits early with a plain message on a `tethered: true` node (its views
  are published by its owner, never by itself). Wired into `garrison-redeploy.sh` right after the
  existing views publish.

## Tests (283 total across this session's touched suites; this batch's new/changed ones)

`tests/remote-shell-tether.test.ts` (13, new) - argv shape, owner gate, up/suspect/unhealthy on
evidence, the two-miss retire+respawn (proven by actually closing the fake `-L` listeners and watching
`tick()` react), onUp firing exactly once, `status()` shape, and the `tether.json` write (including that
a forward with no `publish.servePort` is skipped). `tests/remote-shell-host-credential.test.ts` gained
the `pushHostToken: false` skip case. `tests/remote-shell-runtime.test.ts` gained a `normalizeTether`
case covering the reserved-servePort drop, the missing-localPort drop, and the no-owner refusal.
`tests/compositions-v4.test.ts` gained four `unstation` cases (removes, applies after config merge,
refuses the three protected ids while still applying the rest of the list, no-ops on an unknown id).
`tests/node-identity.test.ts` gained three cases for `tethered`/`tetherHost`/https-only
`appOrigin`/`shellOrigin`. `tests/node-switch.test.ts` gained four cases for the appOrigin-over-
tailnetHost preference. `tests/tailnet-serve-tether.test.ts` (5, new) - spawns the real script against a
scratch `GARRISON_HOME`: no node.json refuses (exit 2), no tether.json is a plain exit-0 message, an
out-of-band servePort dry-runs as `would-add`, an in-band or fixed-infra servePort is refused (exit 1)
without ever attempting a real `tailscale serve` call.

## Live deploy (dev-madrid)

`npm run node:redeploy` (fittings + scripts changed): built, `down`, `up`, both publishers ran.
`tailnet-serve-tether.mjs` correctly printed `No tether.json ... nothing tethered on this node yet` (the
composition's csg transport has no `tether` block yet - see below) and exited 0, so the redeploy was not
disrupted by having nothing to publish. Post-deploy checks: `/api/mesh/self` `views: {total: 17, healthy:
17, unhealthy: []}`; `GET :8098/tether` -> `{"tether":[]}` (correct - nothing declares a tether block
yet); `GET :8098/transports` still lists the (unmodified) legacy `csg` transport; `GET /api/sessions`
still returns rows. No regression from this batch.

## What's still not done

- **The composition's csg transport has not been switched to `swift-book-df6tw47.eun1` + `pushHostToken:
  false` + a `tether` block yet.** Deliberately deferred: doing it now (through the Muster-safe write
  path per F-003) would arm a tether whose owner side has never actually dialed a real tethered node,
  which cannot be verified at all while csg is locked out. Do this once csg answers again.
- The installer flags (`install-node.sh --tethered ...`), the preflight scripts
  (`csg-node-preflight.sh`/`.mjs`), `git-only-shell.sh`, `csg-node-install.sh`, `csg-node-redeploy.sh`,
  and `compositions/default/local.yml`'s actual unstation list for csg (`csg-local.yml.example`) are ALL
  unstarted. These are the G7-facing pieces the plan itself gates on csg being reachable, and several
  (the preflight's exact remote-environment checks) genuinely benefit from being written against live
  feedback rather than guessed blind - see F-004 for why this session stopped writing more of them
  tonight.

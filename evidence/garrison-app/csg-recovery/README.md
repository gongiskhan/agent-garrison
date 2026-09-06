# csg shell and pendant recovery, 2026-09-06

Before: csg checkout 7025b9f04310, served bundle 54911b6e; tunnel and
Shells service healthy. Existing pnmui-monorepo remote-shell conversation
reproduced stuck LINKING in the browser. Local fitting discovery advertised
an obsolete azure-host tailnet URL instead of the enrolled tether origin.

Historical evidence: Claude's tether fix 5bb4be7b and iOS failover 601e748e /
03fc8e22 (TestFlight 32) were already committed; neither repairs the legacy
thread WebSocket URL. See D64 and D65 in the app decision document.

Changes: direct Shells origin for legacy threads; enrolled origin for tethered
fitting discovery; bounded connection handshake; installed supervisor restart;
idempotent pendant Connect and persistent manual pause; bounded failure retry.

Validation: 98 distinct remote Vitest tests passed across 11 files; typecheck passed
after installing the isolated checkout's separate Drill dependencies. csg's
optimized production build passed. Native CI compiled and passed 110/111 tests;
the sole failure was the ownership source invariant still expecting the old
unconditional foreground connect call, now corrected for reconnectIfNeeded.
Deployment initially hit a bootstrap cycle: missing Shells -> tether retirement
-> state unavailable during setup/verify. Recovery starts the real Shells fitting
first; that ordering is now included in both deployment scripts. Final live
and native release results follow.

Live result: csg is RUNNING, 21/21 verify and 10/10 own-port fittings healthy.
The browser serves bundle 541830f5; the checkout is 040514fc (the later changes
are the deployment helper, its tests and documentation, not the web bundle).
The real fitting advertises https://dev-madrid.tail31efa.ts.net:8998. The existing
6861f2b7-58f5-450c-a2db-fddb96876041 / pnmui-monorepo tmux session was preserved.
The formerly stuck thread reaches IDLE and a browser-entered printf returned
CSG_SHELL_OK. At 390x844, Show conversations expands and switching to Zeca
works. Viewport override was reset after the check. No agent prompt was sent.
The tether remained UP with zero misses after recovery, including the final
02:27:09 UTC check. The new bootstrap helper also passed against the live node.

csg's pre-update manifest patch remains recoverable in the named stash
csg-before-ios-recovery-20260906; reverse-apply validation proved it is already
included upstream. Its setup-regenerated apm.lock.yaml is left untouched.
dev-madrid's live checkout and services were not redeployed. Tests used
/tmp/garrison-csg-check.eBRNxi there, with isolated dependencies and test homes.

Native release: final CI run 34006060689 on ab602f77 succeeded: 111 XCTest,
zero failures; build 35 uploaded to App Store Connect/TestFlight at
2026-09-06 02:26:16 UTC. It includes all native changes. The later 040514fc
change is shell-script-only. Run: https://github.com/gongiskhan/ios-thing/actions/runs/34006060689
Apple processing and installation on the actual phone were not observed.
Real phone: exact power warning, reconnect behaviour and pause acceptance
remain unverified. No claim is made that a BLE change fixes USB power draw.

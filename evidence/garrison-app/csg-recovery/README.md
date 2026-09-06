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

Validation: pending remote Vitest/typecheck and CI XCTest. Deployment pending.
Real phone: exact power warning, reconnect behaviour and pause acceptance
remain unverified. No claim is made that a BLE change fixes USB power draw.

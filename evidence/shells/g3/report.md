# G3 (server-side) evidence - aggregated session list, shellBinding, transcript parsers, peer proxy

Captured 2026-09-03 on dev-madrid, live prod (port 8777), after `npm run node:reload`.

## vitest (talk + mesh + web-channel family): 118 tests, 6 files, all green

```
 ✓ |unit| tests/talk-mesh-sessions.test.ts (4 tests) 436ms
 ✓ |unit| tests/vocabulary.test.ts (7 tests) 767ms
   ✓ vocabulary — a conversation is not a session > no user-visible string on the conversation surfaces calls one a session 399ms
 ✓ |unit| tests/mesh-proxy.test.ts (53 tests) 3415ms

 Test Files  6 passed (6)
      Tests  118 passed (118)
```
(full run in the commit's CI log also covers talk-shell-binding, talk-transcript-formats, web-channel-threads;
the broader 537-test regression sweep from the commit message covers every talk/web-channel/mesh file.)

## typecheck + lint: clean

## live prod

`GET /api/sessions`:
```
self: {'node': 'dev-madrid', 'accentColor': '#4a7d5f'}
nodes: ['dev-madrid', 'goncalos-mac-mini-1', 'goncalos-macbook-air-1', 'goncalos-macbook-pro']
rows: 50
```
Peer nodes are discovered from the roster; they contribute 0 rows until they run their own G1/G2 code
(section 4 of the plan - mesh rollout).

`GET /api/sessions/3997a816-32a5-4dbe-8113-1243461092df/stream` (this very session's own live transcript,
streamed back through the new endpoint - id resolved from the `/api/sessions` row list, not hardcoded):
```
data: {"type":"init","available":true,"live":true,"title":null,"events":[{"id":"62b32d20-1540-4812-a816-98b839575932","role":"user","ts":1788385120640,"toolResultsOnly":false,"blocks":[{"type":"text","text":"<local-command-caveat>...
```

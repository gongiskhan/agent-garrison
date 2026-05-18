# What's new — Workbench dissolution

**Date:** 2026-05-18
**Branch:** `main` (10 new commits since `b1ccca0`)
**One-liner:** The Workbench is gone. Each tool runs on its own port.

---

## The 60-second version

The five tool Faculties (Terminal, Screen Share, Worktrees, Session View,
Outposts) used to live as tabs in `/workbench`, sharing a parent shell, an
event bus, and a prefs store. They now stand alone — each Fitting ships
its own React UI + HTTP server on its own port (Monitor pattern).
Garrison's shell now has a thin `/tools` discovery page that lists them.

Net diff: −2854 lines (3856 in / 6710 out).

---

## What to check (10 things, in increasing depth)

### 1. The new `/tools` page

```bash
npm start                                  # boots Next.js on :3000
# in another shell, boot all 5 tool Fittings:
for f in terminal-armory-default:7078 screen-share-default:7079 \
         worktree-management-sequoias:7080 session-view-sequoias:7081 \
         outpost-tailscale-host:7082; do
  id=${f%%:*}; port=${f##*:}
  node fittings/seed/$id/scripts/start.mjs --port $port &
done
```

Then open <http://localhost:3000/tools>. You should see 5 entries with
green dots, each with an "Open" button that opens the Fitting's URL in
a new tab. The same 5 entries also appear at
`GET http://localhost:3000/api/tools/discover` (JSON).

### 2. The five Fittings, in browser tabs

Each is independently usable, no Garrison shell required.

| URL | What it does |
|---|---|
| <http://127.0.0.1:7078> | Terminal — auto-creates a PTY session; type stuff; new tab button works |
| <http://127.0.0.1:7079> | Screen Share — "Start" runs `screencapture -x` (needs macOS Screen Recording permission for the launching process) |
| <http://127.0.0.1:7080> | Worktrees — paste `/Users/ggomes/dev/garrison` in the repo box, Load, then create branch `feat/foo` |
| <http://127.0.0.1:7081> | Session View — auto-shows whatever is in `~/.garrison/sessions/state.json` |
| <http://127.0.0.1:7082> | Outposts — proxies to the outpost-host daemon; 503 banner if it isn't running |

Kill any of them with `kill %N` and watch the status file at
`~/.garrison/ui-fittings/<id>.json` disappear; the `/tools` page reflects
that within 15 s.

### 3. The cross-Fitting wiring (the load-bearing part)

Boot both Worktrees (7080) and Session View (7081), then:

```bash
curl -X POST http://127.0.0.1:7080/worktrees \
  -H "Content-Type: application/json" \
  -d '{"repoPath":"/Users/ggomes/dev/garrison","branch":"play/check-wiring","baseBranch":"main"}'

curl -s http://127.0.0.1:7081/sessions | jq '.sessions[] | select(.branch=="play/check-wiring")'
```

Should return the worktree you just created. Cleanup:
`curl -X DELETE http://127.0.0.1:7080/worktrees/<id-from-previous-output>`.

This works because both Fittings hit `~/.garrison/sessions/state.json` —
no in-process coupling, no API gateway. **This is the dissolution's
proof of concept.**

### 4. The live chat round-trip on Max plan

```bash
npm start
curl -X POST http://127.0.0.1:3000/api/runner/dogfood-orch/up -d '{}' \
  -H "Content-Type: application/json"
# wait ~5s
curl -X POST http://127.0.0.1:3000/api/runner/dogfood-orch/chat \
  -H "Content-Type: application/json" -H "X-Garrison-Origin: ui-tab" \
  -d '{"message":"List the five developer tool Faculties. Terse. End with [orchestrator-active]."}'
```

The orchestrator (Claude via your `~/.claude/` OAuth) should answer with
`terminal, screen-share, worktree-management, session-view, outposts`
followed by `[orchestrator-active]`. I verified this end-to-end during
Phase 7 — see `verification/dissolve-workbench/run-2026-05-17T13-08-01-205Z/`.

### 5. The Run tab on `default` is intentionally stale

The Run tab you screenshotted is showing `compositions/default`, which
was installed back when the 5 Fittings still had `setup.sh`/`verify.sh`.
To refresh:

```bash
cd compositions/default && apm install --force
```

…or switch the dropdown to `dogfood-orch`, which I rebuilt end-to-end.
Dogfood-orch goes 19/19 green and includes the orchestrator soul that
the chat round-trip uses.

### 6. `npm run typecheck` is clean

```bash
npm run typecheck
echo $?     # 0
```

### 7. `grep workbench` is zero

```bash
grep -ri workbench src/ fittings/seed/ compositions/
echo $?     # 1 (no matches)
```

The string only survives in `docs/decisions/`, `docs/phases/`, and the
brief markdown files — all explicitly out-of-scope per the goal.

### 8. The Sidebar shows "Tools" instead of "Workbench"

Open <http://localhost:3000/chat> (or any page). The left nav now lists:

```
Home · Compose · Armory · Run · Chat · Tools · Vault
```

`Tools` links to `/tools` (the discovery page). The old `/workbench`
route is gone.

### 9. The Playwright verification script

```bash
node verification/dissolve-workbench/run.mjs
```

It boots the 5 Fittings, records video, exercises each one, prints 5
`SMOKE OK: live` lines, and finishes with `DISSOLVE-WORKBENCH OK`. Add
`GARRISON_CHAT_URL=http://127.0.0.1:3000 GARRISON_CHAT_COMPOSITION=dogfood-orch`
to also do the chat round-trip (Garrison must be `up`).

Results land in `verification/dissolve-workbench/run-<timestamp>/` with
7 screenshots and 6 webm clips.

### 10. The deliberate gaps

I shipped slim ports — fine for the dissolution decision, missing some
of what the old Workbench did. None of these are needed for the new
architecture to work; they're follow-ups:

- **Terminal:** no SSH host store yet; UI uses a plain `<pre>` instead of
  xterm.js (the WS protocol is xterm-ready)
- **Worktrees:** no port pool, no env-file rewriting, no PR creation
  — `DELETE :id` does discard only
- **Session View:** local-only; outpost aggregation (was via
  `outpost-rpc`) needs to be re-added by consuming the `outpost`
  capability
- **http-gateway:** `spawnInteractiveTab` still points at deleted Next.js
  endpoints; orchestrator falls back to `mode: "headless"` gracefully —
  repointing at the Terminal Fitting on 7078 is the obvious next step

---

## Files to skim, by intent

| Question | File |
|---|---|
| Why was this done? | `docs/decisions/2026-05-17-dissolve-workbench.md` |
| What was done, with evidence? | `docs/phases/2026-05-17-dissolve-workbench-report.md` |
| Reference template for any tool Fitting | `fittings/seed/monitor-default/` |
| How does a Fitting's server look now? | `fittings/seed/session-view-sequoias/scripts/server.mjs` (cleanest) |
| The verification script | `verification/dissolve-workbench/run.mjs` |
| Where the /tools page lives | `src/app/tools/page.tsx`, `src/components/tools/ToolsPanel.tsx`, `src/app/api/tools/discover/route.ts` |

---

## Commits to read (oldest → newest)

```
42a4a62 session-view  → own port 7081 (read-only state.json)
f2d97d1 screen-share  → own port 7079 (screencapture loop)
02f6e9b outposts      → own port 7082 (proxy to outpost-host)
c8e206f worktrees     → own port 7080 + WIRING verified live
7a0f2fc terminal      → own port 7078 (PTY/WS, marker-echo verified)
1a07690 Phase 3: drop family / rename mode + origin / typecheck green
fbff750 Phase 6: ADR written
448006c Phase 4+5: delete scaffold + /tools discovery page
ae48dca Phase 7: Playwright verification script
9919f54 docs: full phase report
```

Each commit message has its own verification block; the worktrees one is
the most informative because it includes the cross-Fitting wiring proof.

---

## If something feels off

- **Run tab red on the default composition** — expected; see #5 above.
  `apm install --force` in `compositions/default` fixes it.
- **xterm-ish escape codes showing as `[31m`** — yes; the Terminal UI's
  current renderer doesn't strip ANSI. The PTY data round-trips fine; it's
  just the display. Swap in xterm.js when convenient.
- **/tools page empty** — none of the 5 Fittings is running. Boot one
  with `node fittings/seed/<id>/scripts/start.mjs --port <port>` and the
  list populates within 15 s.
- **Chat round-trip 500s** — the dogfood-orch composition isn't `up`.
  POST `/api/runner/dogfood-orch/up` first; wait ~5 s for the verify
  hooks to pass.
- **Outposts shows 503** — the outpost-host daemon (`node
  scripts/outpost-host.mjs`) isn't running. `npm start` brings it up
  alongside Next.js.

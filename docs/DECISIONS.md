# Decisions

Append-only record of notable design decisions. Read alongside
[GOVERNANCE.md](./GOVERNANCE.md). Each entry: date, one-line decision,
source, status.

Status vocabulary:

- **Settled** — decided and not under active reconsideration.
- **Open** — decision pending; current direction is provisional.
- **Deferred** — out of scope for the current milestone; target
  milestone noted.
- **Out of scope** — explicitly not in v1 and not planned for the next
  milestone either; reconsider later if conditions change.
- **Reconsidering** — was Settled, now under fresh review.

---

## 2026-05-04 · Garrison v1 scope reset

Garrison v1 is scoped to "composer for agents". The
platform-for-platforms drift items (multi-host compositions, portable
ESM bundles, four-zone layout vocabulary) are closed.
**Source:** consolidated v1 plan §13. **Status:** Settled.

## 2026-05-04 · Capability vocabulary slimmed to 5 kinds

The capability vocabulary is `orchestrator`, `agent-skill`,
`memory-store`, `automation-runner`, `vault`. The earlier 15-kind
sketch is shelved.
**Source:** consolidated v1 plan §13 (capability vocabulary slimming),
[CAPABILITIES.md](./CAPABILITIES.md). **Status:** Reconsidering —
the five grew to nine across Phases 1–3 (`soul`, `data-source`,
`channel`, `artifact-store` each added on Claude-Code-justified
evidence). The "no premature 15-kind menu" intent stands; new kinds
are only added when a real Fitting needs one. Full current list in
[CAPABILITIES.md](./CAPABILITIES.md).

## 2026-05-04 · `x-garrison` manifest block name retained

Earlier discussion considered renaming the manifest block to
`garrison:`. The Terminology doc settled it as `x-garrison` (preserves
the apm convention of `x-` for vendor extensions). Don't relitigate.
**Source:** consolidated v1 plan §0 ("One decision the implementing
agent should not relitigate"). **Status:** Settled.

## 2026-05-04 · Faculty terminology adopted

The slot concept is named **Faculty**, not Primitive. Code symbols,
manifest fields (`faculty:`), and UI strings are renamed. The parser
accepts the deprecated `primitive:` key with a console warning for
back-compat across one minor version.
**Source:** Terminology doc (referenced in plan §0); implemented in
Phase 1 of the consolidated v1 plan. **Status:** Settled.

## 2026-05-04 · Fitting terminology adopted

The installed-component concept is named **Fitting**, not Component.
File-system path `components/seed/` moved to `fittings/seed/`; library
entries renamed. The `src/components/` React directory keeps the name
because there it means React component, not Garrison Fitting.
**Source:** Terminology doc; Phase 1 of the consolidated v1 plan.
**Status:** Settled.

## 2026-05-04 · `src/components/` directory retained intentionally

The `src/components/` directory keeps the word "component" because in
that path it refers to React components, not to Garrison Fittings.
Future "remove all `component` references" passes must NOT rename it.
**Source:** consolidated v1 plan §3.1 ("NOT where they refer to React
components — those stay `Component`"). **Status:** Settled.

## 2026-05-04 · `component_shape` YAML field name retained

The `x-garrison.component_shape` YAML field was not renamed to
`fitting_shape` even though TypeScript identifiers (`fittingShapes`,
`FittingShape`) were. Per plan §3.1, "the YAML field name itself stays
... don't churn manifest schemas for cosmetic gain." Same reasoning
applies to `cardinality_hint`.
**Source:** consolidated v1 plan §3.1. **Status:** Settled.

## 2026-05-04 · testing-framework Faculty renamed to skills, purpose broadened

The Faculty at slot 6 is renamed from `testing-framework` to `skills`
with a broader purpose: reusable capabilities the Operative can invoke,
of which test authoring is one valid shape. The parser accepts the
deprecated `testing-framework` value with a console warning.
**Source:** consolidated v1 plan Phase 4 (§6). **Status:** Settled.

## 2026-05-04 · License pending decision between MIT and Apache-2.0

The v1 release license is not formally chosen. `CONTRIBUTING.md` lists
MIT as the working default; no `LICENSE` file is committed because
adding one is the decision. Choose before the first external Fitting
submission.
**Source:** consolidated v1 plan §15 (decision points to surface).
**Status:** Open.

## 2026-05-04 · Honesty Test text is drafted from plan context

The text of the Honesty Test in [GOVERNANCE.md](./GOVERNANCE.md) §3 is
drafted from references in the consolidated v1 plan, not copied
verbatim from the canonical Governance doc (which was not available
at write-time). Replace the section verbatim when the canonical text is
recovered.
**Source:** plan §10.1 ("the Honesty Test stays exactly as written.
Verbatim"). **Status:** Open.

## 2026-05-04 · Multi-host compositions out of v1

Garrison v1 cannot host one composition across multiple host surfaces
(web + Slack + others) simultaneously. Each composition runs on one
host: Claude Code locally.
**Source:** consolidated v1 plan §13 (Permanently out of v1).
**Status:** Out of scope.

## 2026-05-04 · Portable cross-host ESM bundles out of v1

Fittings ship as APM packages with optional in-process trusted React
extensions. There is no portable ESM bundle dynamic loading model with
mount/unmount across hosts.
**Source:** consolidated v1 plan §13. **Status:** Out of scope.

## 2026-05-04 · Four-zone layout vocabulary out of v1

The four-zone layout vocabulary from earlier sketches is dropped.
Garrison composes operatives, not layouts.
**Source:** consolidated v1 plan §13. **Status:** Out of scope.

## 2026-05-04 · Full 15-kind capability vocabulary out of v1

The earlier 15-kind sketch is replaced by the 5-kind vocabulary
(decided above). The other 10 kinds are not in v1; revisit only if a
real use case demands one.
**Source:** consolidated v1 plan §13. **Status:** Out of scope.

## 2026-05-04 · Multi-user / multi-process Garrison out of v1

Garrison runs as a single-user, single-process local app. No
multi-user state, no multi-process locking, no per-user vault scoping.
**Source:** consolidated v1 plan §13. **Status:** Out of scope.

## 2026-05-04 · AI-driven validators deferred to runtime SDK milestone

The architecture and quality validators in `src/lib/validation/` are
real. The security and prompt-injection validators are placeholder
pattern scanners. The AI-driven implementations land in the runtime
SDK milestone alongside the `Runtime` interface itself.
**Source:** consolidated v1 plan §13 (Deferred). **Status:** Deferred
(target: runtime SDK milestone).

## 2026-05-04 · Runtime `consume()` / events / lifecycle deferred

The actual `Runtime` interface (`consume()`, `events.emit/on`,
`ui.show/hide`, `lifecycle.on`) and Pattern A synchronous sub-agent
invocation are deferred. Capability stubs in
[CAPABILITIES.md](./CAPABILITIES.md) are marked "TBD — runtime SDK
milestone."
**Source:** consolidated v1 plan §13. **Status:** Deferred (target:
runtime SDK milestone).

## 2026-05-16 · Monitor Faculty added; capability vocabulary grows again

A new `monitor` Faculty and `monitor` capability kind are registered
in [`src/lib/faculties.ts`](../src/lib/faculties.ts) and
[`src/lib/types.ts`](../src/lib/types.ts). The Faculty owns
read-only observability of every entity Garrison spawns (PIDs,
status, ports, network, cwd, redacted env, captured logs). The
default Fitting (`fittings/seed/monitor-default/`) serves its own
React UI on its own port and is consumed via URL link rather than
component sharing or state passing.
**Source:** [`docs/monitor-faculty-brief.md`](./monitor-faculty-brief.md);
phase-1 audit at
[`docs/phases/monitor-feasibility.md`](./phases/monitor-feasibility.md).
**Status:** Settled.

## 2026-05-16 · Shared spawn helper at `src/lib/spawn.ts`

Garrison-controlled spawn sites in `src/lib/runner.ts`
(`spawnMcpGatewayHttp`, `spawnGateway`, `spawnClaude`,
`runShellCommand`, nested `runProcess`) are wrapped by a single
`spawnTracked` helper that tees stdout/stderr to
`~/.garrison/logs/<pid>/{stdout.log,stderr.log,meta.json}`.
`meta.json` redacts env keys matching
`/(_TOKEN|_KEY|_SECRET|_PASSWORD|^TOKEN$|^SECRET$|^PASSWORD$)/i`.
`node-pty` terminal sessions are NOT wrapped (separate pipeline;
the user owns their terminal). Log retention is 24 h after PID
death; the Monitor backend handles cleanup.
**Source:** [`docs/phases/monitor-feasibility.md`](./phases/monitor-feasibility.md) §2.
**Status:** Settled.

## 2026-05-16 · UI-Fitting port convention

Each UI-bearing Fitting declares a default port in
`x-garrison.ui.port`. At start time the Fitting tries to bind that
default; if the port is taken, it falls back via `findFreePort` and
publishes the chosen port at
`~/.garrison/ui-fittings/<fitting-id>.json` for consumers to
discover. Consumers read the status file, then `GET <url>/health`
before linking. No component sharing, no state passing — link by
URL only. Monitor default port: `7077`. Documented in
[`docs/UI-FITTINGS.md`](./UI-FITTINGS.md).
**Source:** [`docs/phases/monitor-feasibility.md`](./phases/monitor-feasibility.md) §3.
**Status:** Settled.

## 2026-05-16 · Worktree port pool stays 50000–54999, exposed via config

The brief illustrated a 3000–3100 pool; the codebase chose
50000–54999 (deliberate, avoids collisions with system services and
common dev servers). The default stays; the range is now config-driven
via env vars (`GARRISON_PORT_RANGE_START`/`GARRISON_PORT_RANGE_END`,
already present) and per-project `port_pool: {start, end}` in
`~/.garrison/projects/<id>.yml`. Treat the brief's `3000–3100` as
illustrative.
**Source:** [`docs/worktrees-and-surface-aware-brief.md`](./worktrees-and-surface-aware-brief.md) §"Port allocation"; user review 2026-05-16.
**Status:** Settled.

## 2026-05-16 · `mcp-gateway --probe` stays lenient by default; `--strict` opt-in

The brief's §3 Health says `mcp-gateway --probe` must exit non-zero
if either underlying Faculty probe fails. The current implementation
exits 0 to support graceful degradation when one of
`tier-classifier` / `testing` is absent. The implementation keeps
its lenient default; a new `--probe --strict` flag exits non-zero
when either underlying probe fails. Workbench launcher can opt into
strict mode via `requireFullMcpSurface` when partial-install
ergonomics are not desired.
**Source:** [`docs/mcp-gateway-fitting-brief.md`](./mcp-gateway-fitting-brief.md) §3; user review 2026-05-16.
**Status:** Settled.

## 2026-05-16 · Tailscale URLs stay `http://` for v1

The worktree brief specified `https://<host>:<port>`. HTTPS on
MagicDNS requires per-service cert wiring the project does not
enforce; switching to `https://` without it would silently break
reachability from mobile. The locked decision is to surface
`http://<host>:<port>` URLs for v1 and revisit when a Garrison-wide
TLS termination story exists.
**Source:** [`docs/worktrees-and-surface-aware-brief.md`](./worktrees-and-surface-aware-brief.md) §"Tailscale URL resolution"; user review 2026-05-16.
**Status:** Settled.

## 2026-05-20 · Lean Garrison trim — Chat, Tools, test box, sub-agent pane removed

The built-in `/chat`, `/tools`, Operative test box, and Sub-agent pane
are deleted. Operative interaction lives in Channel Fittings (Slack
today, Web Channel Fitting planned). The sidebar Views section is the
sole surface for Fitting views. Garrison's documentation drops
consumer-specific paths (`~/.claude/memory-compiler/`,
`~/Projects/awc-gateway-slack/`, `mac-mini/gateway/heartbeat/trello.py`)
and consumer-feature naming. A new
[GOVERNANCE.md §3.1 "Downstream consumers"](./GOVERNANCE.md#31-downstream-consumers)
codifies the rule.
**Source:** [`docs/decisions/2026-05-20-lean-garrison-trim.md`](./decisions/2026-05-20-lean-garrison-trim.md).
**Status:** Settled.

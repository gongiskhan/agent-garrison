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
[CAPABILITIES.md](./CAPABILITIES.md). **Status:** Settled.

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

# Seed Fittings

These local APM packages bootstrap Garrison and provide reference
implementations. The directory intentionally contains migration residue, so its
contents are not the selectable catalogue. `data/library.json` is the
authoritative live registry; each registered Fitting's `apm.yml` is the
authoritative capability contract.

## Live role and capability vocabulary

The exact vocabularies live in `src/lib/types.ts`:

- **16 Faculties:** 8 core roles (`orchestrator`, `channels`, `gateway`,
  `runtimes`, `memory`, `observability`, `sessions`, `surfaces`), 7 optional
  capability roles (`knowledge`, `research`, `building`, `code-intelligence`,
  `design`, `browser-qa`, `coordination`), and `connectors`.
- **16 capability kinds:** `orchestrator`, `identity`, `memory-store`,
  `automation-runner`, `connector`, `runtime`, `mcp-gateway`, `channel`,
  `vault`, `dev-env`, `screen-share`, `outpost`, `monitor`, `voice`, `duty`,
  and the derived `view` kind.

The resolver combines the registered, selected Fittings and enforces their
`provides` / `consumes` cardinality. `view` is derived from `ui.views[]` and
`own_port`; a manifest never declares it under `provides`. The runtime supplies
the synthetic `vault` provider, while Vault-consuming own-port Fittings receive
only their declared `secret_scope`.

## Routing and identity

The `orchestrator` Fitting is the single public home for both concerns. It
provides `identity:authored` and the reserved `duty:dispatch`; its editable
Identity section owns Gary and its Routing inference section owns the bounded
pre-session policy. The assembled layered Orchestrator document is the only
runtime prompt source.

Routing inference and identity are authored inside Orchestrator; there are no
separate routing, persona, or named-mode Fittings.
Legacy composition selections are migrated away, and legacy `soul.md` content
is imported as an authored Identity override at most once rather than injected
unconditionally.

## Scheduled work

User schedules live as cards in Kanban's fixed **Scheduled** column. The single
`kanban-tick` clock creates due occurrences; infrastructure jobs are not cards.
Morning briefing is an enabled recurring template whose normal occurrences
summarize Calendar and Kanban focus and record independent Web/Omi delivery
receipts.

The old `morning-briefing` package and scheduler registration may remain on disk
only during the guarded live cutover: seed and verify the Scheduled template and
a Run-now occurrence first, then retire the old job/package without duplicate
delivery. They are not the target public scheduling model.

## Views and validation

Every registered Fitting has a view: either `x-garrison.ui.views[]` or
`own_port: true`. Shared `garrison:*` views cover packages that do not need
fitting-side UI code. See `docs/UI-FITTINGS.md` for the canonical own-port and
view contract, and `docs/METADATA.md` for the manifest schema.

# Governance

> **Status note:** sections 1–6 of this document are drafted from the
> consolidated v1 plan's references to a canonical Governance doc that
> was not in the working set when this file was written. When that
> source is recovered, replace the relevant sections verbatim. The
> intent of every section here matches the plan's guidance even where
> the wording does not.
>
> The running record of what's settled, open, and reconsidered lives
> in [DECISIONS.md](./DECISIONS.md). Read that alongside this file.

## 1. Positioning

Agent Garrison is an open-source distribution and composition platform
for Claude Code. It is the place to compose a long-running operative
out of swappable Faculties and Fittings, save the result as an APM
manifest, and run it locally. Other Claude Code consumers (notably
Ekoa) happen to use it; they are not its reason for existing.

The project is local-first. Single-user, single-process, ships with no
hosted services. Downstream users are free to operate their own hosted
deployments; the project itself ships nothing of the kind.

## 2. Positioning principles

These principles guide what gets accepted and what gets rejected.

1. **Claude Code first.** Every design decision should land cleanly on
   a Claude Code use case. If a feature only makes sense because of a
   downstream consumer, it does not belong in v1.
2. **Composer not orchestrator.** Garrison composes. The runtime
   spawns Claude Code with the assembled prompt. Garrison does not
   re-implement Claude's runtime.
3. **Inspectable over magical.** Prefer one-line scripts the user can
   read over abstractions that hide what's happening. The Vault is
   AES-256-GCM encrypted but a flat `data/vault.json`. The composition
   is an APM manifest the user can hand-edit.
4. **Local trust boundary.** Everything in this repo runs on the
   user's machine, under the user's account, with the user's
   credentials. There is no multi-tenant isolation to design for.

## 3. The Honesty Test

For every design choice, ask:

> Does this make sense for Claude Code on its own merits, with no
> reference to any specific downstream consumer?

If the honest answer is no, the choice does not belong in v1. The
default action is to leave it out, not to silently delete it — record
it in [DECISIONS.md](./DECISIONS.md) so a future maintainer can
reconsider it with full context.

The test applies to features, primitives (Faculties), capability kinds,
runtime hooks, the validation pipeline, and the documentation. If a
paragraph in the docs reads as "Downstream X needs Y, therefore
Garrison does Z", rewrite it as "Z, because [Claude-Code-justified
reason]; X happens to use this too." If you can't write that second
form honestly, the underlying decision is what needs to change.

## 4. Contribution model

### 4.1 Fittings (the most-wanted contribution)

The most valuable contribution is a new Fitting that fills a Faculty
slot for a real Claude Code use case. Fittings live in their own git
repos and are listed in the Fittings Registry; the Garrison repo
itself ships only the seed reference Fittings.

A Fitting is a directory with an `apm.yml` manifest containing an
`x-garrison` block, optional skill / instruction / script / UI
extension content, and a `verify` hook the runner uses to confirm
installation succeeded. See [FITTINGS.md](./FITTINGS.md) for the
manifest contract.

### 4.2 Platform contributions

Improvements to the Garrison platform itself — the composer, the
runner, the validation pipeline, the resolver, the docs — are
welcome. See `CONTRIBUTING.md` for the PR flow.

### 4.3 Validation pipeline

Official Fittings Registry listings pass an automated validation
pipeline before they appear. Today the pipeline runs four checks:

- **architecture** — the manifest parses, the Faculty exists, the
  shape is accepted, capability provisions/consumptions parse cleanly,
  the verify hook is non-empty.
- **security** — placeholder pattern scanner; the AI-driven version
  lands in the runtime SDK milestone.
- **prompt-injection** — placeholder pattern scanner; AI-driven
  version deferred.
- **quality** — config schema fields are documented, optional
  metadata is well-formed.

A submission that fails any check is not listed. The check pipeline
itself can run locally via `tsx scripts/validate-fitting.ts <path>`.

## 5. Milestones

The current milestone is **Garrison v1** — composer surface, capability
wiring contract, validation scaffolding, terminology and governance
landed. The next milestone is the **runtime SDK** — actual
implementations of the orchestrator, agent-skill, memory-store,
automation-runner, and vault interfaces, plus the AI-driven validators.

Anything outside the current milestone is recorded in
[DECISIONS.md](./DECISIONS.md) with a status of `Deferred` and a
target milestone, or `Out of scope` with a rationale.

## 6. License

The license is open and not yet selected for the v1 release. The
default in `CONTRIBUTING.md` is MIT pending an explicit decision; see
[DECISIONS.md](./DECISIONS.md). No `LICENSE` file is committed yet —
adding one is the act that closes the decision.

## 7. Decision log

Every notable design decision is recorded in
[DECISIONS.md](./DECISIONS.md) with a date, one-line summary, source
reference, and a status of Settled / Open / Deferred / Out of scope /
Reconsidering. Append, don't rewrite — history is the point.

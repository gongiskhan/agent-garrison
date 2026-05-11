# Contributing to Agent Garrison

Read [GOVERNANCE.md](./GOVERNANCE.md) before opening a substantive PR.
The Honesty Test (§3) is the single most useful gate.

## What we want most

A new **Fitting** that fills a Faculty slot for a real Claude Code use
case is the most valuable contribution. The Garrison repo itself ships
only the six seed Fittings; everything else lives in its own repo and
is listed in the Fittings Registry.

A Fitting is a directory containing:

- `apm.yml` with an `x-garrison` block declaring the Faculty,
  cardinality hint, fitting shape, supported platforms, config schema,
  capability `provides` / `consumes`, and a `verify` hook.
- Optional skill, instruction, script, or UI extension content under
  `.apm/`, `scripts/`, or `ui/`.

See [FITTINGS.md](./FITTINGS.md) for the manifest contract and
[CAPABILITIES.md](./CAPABILITIES.md) for the capability vocabulary.

## Platform contributions

Improvements to the composer, runner, validation pipeline, resolver,
or docs are welcome. The PR flow:

1. Open an issue describing the problem and the proposed change before
   writing code, unless the change is small and self-evident.
2. Branch, write tests, run `npm test` and `npx tsc --noEmit`.
3. Open a PR. Include the rationale; if the change touches a design
   decision, propose a `DECISIONS.md` entry too.
4. CI runs the validation pipeline across the seeds.

## The Honesty Test for contributors

Before submitting, ask:

> Does this change make sense for Claude Code on its own merits, with
> no reference to any specific downstream consumer?

If the honest answer is no, hold the change. The right path is usually
not to delete the idea but to record it in `DECISIONS.md` as `Open`
for a future maintainer to reconsider.

## Validation gate

Official Fittings Registry listings pass an automated validation
pipeline of four checks: architecture, security, prompt-injection,
quality. Submissions failing any check are not listed.

You can run the pipeline locally:

```bash
tsx scripts/validate-fitting.ts path/to/your/fitting
```

The architecture check is real and final. The security and
prompt-injection checks are placeholder pattern scanners in this
milestone (see [GOVERNANCE.md](./GOVERNANCE.md) §4.3); the AI-driven
versions land in the runtime SDK milestone.

## Licensing

The license is **MIT by default**, but the v1 release license has not
been formally chosen — `LICENSE` is intentionally not committed yet.
This is tracked as `Open` in [DECISIONS.md](./DECISIONS.md). If you
contribute now, you implicitly agree your contribution can be
relicensed under whichever license the maintainer selects between MIT
and Apache-2.0.

## How to submit a Fitting

1. Open a GitHub issue titled `Fitting submission: <name>` linking to
   your Fitting's git repo.
2. The maintainer runs the validation pipeline against the linked
   commit and posts the report to the issue.
3. If the report is `pass`, a Registry entry is added. If it's `fail`,
   the issue documents what to fix.

The Registry currently lives as `data/library.json` in this repo. A
future milestone will move it out-of-tree, but the listing process is
the same.

## How to contribute to the platform

Standard PR flow:

1. Fork, branch.
2. Write code and tests. Type-check (`npx tsc --noEmit`) and run the
   test suite (`npm test`). Both must pass.
3. Open the PR with a clear description of the why, not just the what.
4. If the change is more than a small bugfix, propose a
   `DECISIONS.md` entry as part of the same PR.

# Capabilities

The five capability kinds Fittings can `provides` or `consumes` in
their `x-garrison` block. Cardinality is enforced by the resolver
(`src/lib/capabilities.ts`); see [GOVERNANCE.md](./GOVERNANCE.md) and
[FITTINGS.md](./FITTINGS.md) for context.

> **Interface stubs are TBD — runtime SDK milestone.** Each section
> below describes what each kind is for and what its interface will
> need to expose. The actual TypeScript signatures are intentionally
> not specified here so the runtime SDK milestone can design them
> against real implementation pressure rather than inheriting
> speculative shapes.

---

## orchestrator

The capstone Fitting that governs the operative's behavior. There is
exactly one orchestrator per composition.

- **Cardinality:** singleton (the resolver enforces this across the
  whole composition).
- **Typically provides:** the Fitting that owns the orchestrator
  Faculty.
- **Typically consumes:** nothing — it is the consumer of everything
  else.
- **Interface (TBD — runtime SDK milestone):** must accept the user
  prompt, dispatch to `agent-skill` consumers, observe lifecycle
  events from `automation-runner` providers, persist via
  `memory-store`, and read secrets from `vault`.

## agent-skill

A reusable procedure or sub-agent the orchestrator can invoke during a
session. Examples: a tier classifier, a summarizer, a test author.

- **Cardinality:** any number can provide; consumers may want exactly
  one named skill, any of a kind, or all available.
- **Typically provides:** Fittings in the `skills` or `classifier`
  Faculty.
- **Typically consumes:** the orchestrator (transitively, via being
  invoked).
- **Interface (TBD — runtime SDK milestone):** must accept a
  structured input from the orchestrator and return a structured
  output without spawning a long-lived process.

## memory-store

Within-session and cross-session recall for the operative.

- **Cardinality:** typically one; the resolver does not flag it as a
  singleton kind so a composition that needs more than one (e.g.,
  scratchpad + long-term) is still legal.
- **Typically provides:** the Fitting in the `memory` Faculty.
- **Typically consumes:** `vault` for any encrypted persistence.
- **Interface (TBD — runtime SDK milestone):** must support read,
  write, and a compaction/persistence cadence the orchestrator can
  trigger or observe.

## automation-runner

A scheduled or event-driven driver that wakes the operative without a
direct user prompt. The heartbeat is the canonical example.

- **Cardinality:** any number; a composition can have multiple drivers
  on different cadences.
- **Typically provides:** Fittings in the `heartbeat`, `scheduler`, or
  `automations` Faculty.
- **Typically consumes:** the orchestrator (a runner needs something
  to dispatch to).
- **Interface (TBD — runtime SDK milestone):** must dispatch a
  job-like payload to the orchestrator's input boundary and surface
  outcomes the observability layer can record.

## vault

Encrypted secret storage the runtime always provides synthetically.
Fittings consume this to read API keys and other secrets without
embedding them in the manifest.

- **Cardinality:** singleton, always provided by the runtime
  (`__runtime__` synthetic node in the resolver).
- **Typically provides:** the runtime, not a Fitting.
- **Typically consumes:** any Fitting needing secret material.
- **Interface (TBD — runtime SDK milestone):** must support keyed
  read of secrets the user has stored under the Vault tab. AES-256-GCM
  on disk; passphrase-derived key in memory only while the Vault is
  unlocked.

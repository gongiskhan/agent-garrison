# coord-mcp

The coordination **planning gate** for Agent Garrison — a Garrison-owned (MIT,
dependency-free) stdio MCP server that **serializes planning per repo**. This is
the highest-stakes drift guard: architectural decisions are made during planning,
so only one session may plan a given repo at a time, and the next planner inherits
everyone else's context instead of planning blind.

- **Faculty:** `memory` (component shape `cli`). Provides `memory-store: coord-plan-gate`;
  consumes `beads` + `agent-mail` (optional-one) for the read-bundle.
- **Transport:** stdio JSON-RPC 2.0 MCP (same shape as the Knowledge server),
  registered as `coord-mcp` in `~/.claude.json` (user scope) so a direct `claude`
  run in any repo and the orchestrator both get the tools. **No model call** — all
  work is mechanical state-service reads + a `bd` query (PTY-safe).
- **Store:** the Garrison **state service**, so the gate serializes planners across
  every node in the mesh, not just this box. Dependency-free: the generated
  `lib/state-client.mjs` copy imports nothing.

## Tools

- `begin_planning(repo?, summary)` → **WAIT** (another session holds the lock — its
  holder/summary/started/expiry returned) or **GRANTED** + the **read-bundle**:
  (a) the last released plan, (b) recent plans within the lookback window, (c)
  in-flight intents / decisions / leases. Read it before you plan.
- `end_planning(repo?)` → release the lock (records your plan as the released plan).
- `plan_heartbeat(repo?)` → extend the lock TTL while still planning.
- `plan_status(repo?)` → holder + waiters (observability layer 5).
- `declare_intent(repo?, area, files?, reason)` → record an intent so other sessions
  see it and conflicts surface in their digest.
- `release_intents(repo?)` → clear this session's intents.
- `coord_digest(repo?, area?, files?)` → the repo-scoped digest (lock state + conflicts).

## The lock

A **lease** on the state service, keyed `plan:<repoKey>`, with **TTL + heartbeat**
(default 15 min, `lock_ttl_ms`) and a monotonic **fence**. Exactly one of two
simultaneous acquirers is granted — that decision is a single transaction, not a
file race — and the loser is told who holds it. A crashed or abandoned planning
session auto-releases at TTL; no pid is ever consulted, because a pid means nothing
on another machine.

**There is no local fallback.** When the state service is unreachable, every tool
returns a loud error naming it. A file lock that only one machine believes in
reports a mesh-wide guarantee it cannot make, which is worse than no lock. The
SessionStart/UserPromptSubmit hook is the deliberate exception: it stays silent, so
a mesh outage never breaks every prompt.

**Bounded wait + escalation:** waiting is never unbounded. On WAIT, the session
surfaces that it is waiting and re-checks on a cadence; if the lock is held past its
TTL it auto-releases. An **autonomous** session that cannot acquire within its budget
**parks the task and surfaces it** rather than hanging.

## Per-repo scoping

The lease, plan ledger, intent store, and digest are all keyed by the repo's
**normalized origin URL** (`lib/repo-key.mjs`, shared byte-identical with the state
service): `github.com/gongiskhan/agent-garrison`. So the same repo checked out at
two paths on two machines is ONE lock, and — the trap a path hash walked into — the
same path on two machines is not. A checkout with no origin falls back to
`local:<node>:<hash16>`, explicitly node-scoped so it can never collide either.
A session only ever sees coordination state for its own repo.

## Plan → repo association

Claude Code plans live in `~/.claude/plans` with random, non-repo-keyed names, so
coord-mcp does NOT rely on them. Instead it owns a repo-keyed plan ledger (the
state service's append-only `plans` table): `end_planning` records the declared
summary as the released plan, which the next `begin_planning` returns — on any
node.

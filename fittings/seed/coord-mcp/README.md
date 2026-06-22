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
  work is mechanical file scans + a `bd` query (PTY-safe).

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

A **file mutex** at `~/.garrison/coord/plan-locks/<repoSlug>.json` with **TTL +
heartbeat** (default 15 min, `lock_ttl_ms`). MIT + dependency-free, so the strongest
guarantee works even when Beads / agent_mail are down. A crashed or abandoned
planning session auto-releases at TTL — a forgotten plan-mode session can never
block everyone forever.

**Bounded wait + escalation:** waiting is never unbounded. On WAIT, the session
surfaces that it is waiting and re-checks on a cadence; if the lock is held past its
TTL it auto-releases. An **autonomous** session that cannot acquire within its budget
**parks the task and surfaces it** rather than hanging.

## Per-repo scoping

The lock, plan ledger, intent store, and digest are all keyed by the repo's git
toplevel (`repoSlug`). A session only ever sees coordination state for its own repo —
cross-repo contamination is impossible by construction.

## Plan → repo association

Claude Code plans live in `~/.claude/plans` with random, non-repo-keyed names, so
coord-mcp does NOT rely on them. Instead it owns a repo-keyed plan ledger
(`~/.garrison/coord/plans/<repoSlug>.jsonl`): `end_planning` records the declared
summary as the released plan, which the next `begin_planning` returns.

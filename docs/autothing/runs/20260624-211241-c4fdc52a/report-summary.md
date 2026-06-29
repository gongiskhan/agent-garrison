# autothing run 20260624-211241-c4fdc52a — GLOBAL GATE: passed

**Feature:** `runtimes` is now a first-class essential Faculty with selectable engines + provider overrides.

**Slices (5/5 passed):**
- S1 Claude Code Runtime fitting (selectable peer; provider/model/base_url config) + registered agent-sdk-runtime in the library
- S2 selectable PRIMARY runtime (GlobalConfig.primary_runtime) threaded into PTY + gateway spawn, with provider base-url swap
- S3 fitted runtimes auto-surface as model-router targets
- S4 runtimes essential
- S5 Compose UI: primary-runtime selector + per-runtime provider selector

**Verification:** 30+ unit tests, committed e2e 7/7 (live app), typecheck 0, lint clean, same-model review clean, Codex REVIEW approve (fixed 2 real findings), Codex Playwright TEST pass (added agent-sdk-runtime), design audit clean, walkthrough video verified.

**Caveats (no blockers):** agent-sdk-as-primary fails loud (not yet hosted); prod `next build` skipped (shared dev-server .next race — typecheck/lint/e2e pass instead); runtimes shows under f45c7c61's new Dev-tier grid (essential flag set; tier is the user's call).

**Cross-session:** all edits additive/disjoint; coordinated via coord-mcp + beads (epic garrison-ap3, all closed); recovered the shared app from a .next corruption I caused (logged to friction-log).

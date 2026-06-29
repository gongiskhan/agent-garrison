# FLOW_PLAN — V1d UX: add a code comment somewhere trivial

## Context

This card is the **trivial-change smoke test** for the V1d Kanban Loop pipeline
(plan → implement → review → walkthrough). The card title is literal: add ONE
short clarifying comment in ONE place that already wanted one. The point is to
exercise dispatch end-to-end on the cheapest possible diff, not to ship real
work.

## Decision

Add ONE explanatory comment to `fittings/seed/kanban-loop/ui/main.tsx` at the
`setRuntime((prev) => prev)` no-op update inside the `loadRuntime` callback's
catch block. The autothing-review of run `01KVYA1HV6V624CNX87ASSP86S` explicitly
flagged this line as opaque ("functionally a no-op… slightly opaque… could be
an empty catch comment"). A one-line comment makes the intent obvious without
changing behavior. Perfect fit for "trivial".

**Why this site, not a random one:**
- Sourced from a real, captured review nit (not invented).
- Single line, zero behavioral change.
- Pure UI module, no test files need to update.
- No new types, no new exports, no diff outside the catch block.

## Slices

| id | title | files | acceptance |
|----|-------|-------|------------|
| s1 | comment the loadRuntime catch no-op | `fittings/seed/kanban-loop/ui/main.tsx` | one comment line added immediately above (or inline with) the existing `setRuntime((prev) => prev);` call inside the `loadRuntime` `catch` block; the comment names WHY the no-op exists ("older server build without /board/runtime — keep prior runtime, don't clobber"); no other lines changed; `npx tsc --noEmit` clean. |

## Acceptance (machine-checkable)

1. `git diff --stat fittings/seed/kanban-loop/ui/main.tsx` shows EXACTLY one
   file changed with a net `+1`/`+2` line delta (a single comment line, with or
   without a trailing newline). No other files modified.
2. `git diff fittings/seed/kanban-loop/ui/main.tsx` shows ONLY additions inside
   the existing `catch` block of the `loadRuntime` callback, and the existing
   `setRuntime((prev) => prev);` line is preserved verbatim.
3. The added line begins with `//` (a JS line comment).
4. `npx tsc --noEmit` — clean.
5. `grep -n "setRuntime((prev) => prev)" fittings/seed/kanban-loop/ui/main.tsx`
   still matches exactly once (the call wasn't replaced).

## Critical files

- `fittings/seed/kanban-loop/ui/main.tsx` — the only file edited; the
  `loadRuntime` callback's catch block (currently a single statement,
  `setRuntime((prev) => prev);`) is the comment site.

## Out of scope

- Removing the no-op (would change behavior; review only suggested a comment).
- Touching any other "opaque" call site in the codebase.
- Editing the dist bundle (no UI rebuild needed for a comment-only diff).
- Anything in the engine, server, or lifecycle modules.

## Verification recipe (for implement / review / walkthrough)

```
npx tsc --noEmit
git --no-pager diff --stat fittings/seed/kanban-loop/ui/main.tsx
git --no-pager diff fittings/seed/kanban-loop/ui/main.tsx
```

All three commands must complete cleanly; the diff must match the acceptance
above.

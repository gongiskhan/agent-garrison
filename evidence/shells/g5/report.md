# G5 evidence

Cursor stationing (composition + probe fix) and the Quarters `file_sets` engine
(schema, lib, API routes, `RuntimeFileSetPanel`), verified live on dev-madrid.

## Static checks

```
$ npx tsc --noEmit
(clean, exit 0)

$ npm run lint
✔ No ESLint warnings or errors

$ npx vitest run tests/cursor-runtime.test.ts tests/composition-default-stations-cursor.test.ts \
    tests/metadata-quarters-file-sets.test.ts tests/metadata.test.ts tests/quarters-runtimes.test.ts \
    tests/shipped-compositions.test.ts tests/orchestrator-routing-compositions.test.ts \
    tests/instance-isolation.test.ts tests/duty-ladder-schema.test.ts tests/vocabulary.test.ts \
    tests/capabilities.test.ts tests/validation.test.ts tests/muster-model.test.ts
Test Files  13 passed (13)
     Tests  248 passed (248)
```

`tests/quarters-runtimes.test.ts` gained 26 new tests for the file_sets engine (list/read/write/
create/delete, containment property test, glob matching, frontmatter parsing, merge-write
semantics, platform gating, project-scope refusal, `runtimeHome`). `tests/metadata-quarters-file-sets.test.ts`
is new (22 tests) - the manifest-authoring half of the restricted-glob contract.
`tests/cursor-runtime.test.ts` gained a probe-table describe block (absent/no-`GARRISON_REQUIRE_CURSOR`
exits 0 degraded; absent+`GARRISON_REQUIRE_CURSOR=1` exits 1; present-but-unauthenticated always exits 1)
and a real-manifest assertion that all six `file_sets` ids are declared AND listed in `categories`.
`tests/composition-default-stations-cursor.test.ts` is new (3 tests) - pins the dependency +
selection + target the same three-part shape codex/gemini/opencode already have.

## The probe fix (`fittings/seed/cursor-runtime/scripts/bridge.mjs`)

`probeFailure` now returns `{level: "absent"|"unauthenticated", reason} | null` instead of a plain
string, and tries `~/.local/bin/cursor-agent` before declaring the binary absent (a probe has no
login shell, so no PATH augmentation). `--probe`: absent + no `GARRISON_REQUIRE_CURSOR` -> exit 0
with a `degraded:` line (most mesh nodes will never run Cursor); absent + `GARRISON_REQUIRE_CURSOR=1`
-> exit 1 (strict, for a node where Cursor must be present); unauthenticated -> always exit 1 (the
binary being there at all means someone meant this node to run it). Live on dev-madrid (no
cursor-agent installed):

```
$ node fittings/seed/cursor-runtime/scripts/bridge.mjs --probe; echo $?
ok
degraded: no cursor-agent on this node (not found on PATH or in ~/.local/bin (install: https://cursor.com/cli))
0
```

## Stationing - and a real trap this gate found

The plan called for a straight hand-edit of `compositions/default/apm.yml` (dependency + selection +
`cursor-local` target). **That edit was silently reverted** by the next `npm run node:redeploy`'s
`up()` — a known, already-documented pre-existing trap (`syncCompositionFromState` materialises the
STATE SERVICE's copy of the manifest over the local file on every launch; the only durable writer is
the Muster API path, which pushes to the state service with rev CAS after writing the file). See the
memory note `sidebar-menu-and-shared-pins.md` for the earlier 2026-08-26/08-27 occurrences - this is
the third time this exact class of mistake has bitten a session, tracked as pre-existing architecture
debt ("task #31", a three-way reconcile) that this gate did not attempt to fix.

Fixed by using the real write paths instead of a raw file edit:

1. `POST /api/muster/standing/swap {faculty:"runtimes", toId:"cursor-runtime"}` — stations the
   fitting (adds the apm dependency + the runtimes selection with its `model: auto` default from
   `config_schema`), and durably pushes to the mesh state service (`writeStandingSelections` ->
   `mutateManifestAtomic` -> `pushManifestToState`). `orphaned: []` in the response - no consumer
   broke.
2. `POST /api/muster/target {id:"cursor-local", runtime:"cursor", model:"auto", promptMode:null,
   maxTurns:null}` — creates the target, validated (kebab-case id, runtime is provided by a
   stationed fitting, no duty-cell compatibility break). **Found a real gap while doing this**: this
   route's underlying `upsertCompositionTarget` writes via `mutateCompositionBlock`, which — unlike
   `mutateManifestAtomic` — does NOT push to the state service. A target created through the official
   Muster API is therefore just as vulnerable to being silently reverted as a hand-edit was. Not
   fixed here (a shared write path other Muster features use; fixing it is exactly the same task #31
   three-way-reconcile work, out of scope for stationing one runtime) - worked around by hand-adding
   `params: {type: secondary}` to match the shape of the sibling `sec-gemini`/`sec-codex`/`csg-work`
   targets (the target API has no field for `params.type`; traced its only real consumer,
   `routeFromRung` in `stretch.mjs`, and confirmed dispatch itself branches on `target.runtime`
   against `EXEC_ADAPTER_CLASS`, not on `type` - `type` is informational/display, so shipping without
   it would not have broken execution, but matching the sibling shape is still correct), then pushing
   the final manifest to the state service explicitly (a one-off `tsx` script calling
   `pushManifestToState` from `src/lib/composition-sync.ts`, run with `GARRISON_HOME` set - not
   committed, deleted immediately after use).
3. **The Muster API's `dumpYaml` round-trip silently dropped four pre-existing explanatory comments**
   elsewhere in the file (unrelated to Cursor - wake-tuning/REC-button/whatsapp-web/port-8080 notes on
   other fittings' config blocks). `js-yaml`'s dumper does not preserve comments. Restored all four by
   hand, verified the diff carries ONLY the intended additions plus the restored comments, then
   re-pushed. This is a real, general cost of ANY Muster-UI-driven edit (not specific to this gate);
   noted for anyone doing composition surgery by hand-editing after a Muster write.
4. **Acid-tested durability**: ran `npm run node:redeploy` again (a full `down` -> `up()` cycle) and
   confirmed `git diff --stat compositions/default/apm.yml` still showed exactly the intended 9-line
   addition (dependency + selection + target) - the state-service push held.

## Live verification (dev-madrid, `https://dev-madrid.tail31efa.ts.net`)

```
$ curl -sf http://127.0.0.1:8777/api/mesh/self | jq .composition
{"id":"default","status":"running","running":true,...}

$ curl -s http://127.0.0.1:8777/api/muster/standing | jq '.slots[] | select(.faculty=="runtimes") | .fittings[] | {id, providesRuntime, config}'
... cursor-runtime  true  {"model":"auto"}   (alongside every other stationed runtime, all still live)

$ curl -s http://127.0.0.1:8777/api/quarters/runtime/cursor-runtime/sets | jq '.fileSets[] | {id, available, count, reason}'
rules           available:true  count:0
skills          available:true  count:0
agents          available:true  count:0
hooks           available:true  count:0
desktop         available:false reason:"only available on darwin"
project-rules   available:true  (project-scoped, no count)

$ curl -s http://127.0.0.1:8777/api/quarters/runtime/cursor-runtime/projects | jq '.projects | length'
62   # real ~/dev subdirectories on this machine
```

Browser (claude-in-chrome, 1440x900): `/quarters` -> expanded the `cursor` runtime section ->
`GENERIC TIER` pill, one warning banner ("declared home_dir ~/.cursor does not exist... appears
after first run" - correct, this machine has no Cursor install), and nine category cards: Settings/
Context/MCPs (`NATIVE FILE`, unchanged pre-existing surface), Rules/Skills/Agents/Hooks (`0 FILES`,
the new file_sets count pill), Desktop (`UNAVAILABLE` pill, muted, title = the platform reason),
Project rules (`FILES`, no count since project-scoped), Logs (`NATIVE FILE`, unchanged). Screenshot:
`quarters-cursor-cards.jpg`.

Opened `/quarters/cursor-runtime/rules` -> `RuntimeFileSetPanel`: "No files here yet." + "+ New
file". Created `e2e-check.mdc` with a real frontmatter block + body through the UI -> the list
updated, the editor opened, frontmatter chips rendered (`description: e2e check`,
`alwaysApply: false`), autosave fired and the status line read "saved". Verified on the real
filesystem:

```
$ cat ~/.cursor/rules/e2e-check.mdc
---
description: e2e check
alwaysApply: false
---
Verification body.
```

Clicked Delete -> the file and the (now-empty) `~/.cursor/rules/` directory content were gone from
disk, confirmed via `ls`. This exercised the full create -> autosave-write -> delete round trip
against the REAL machine, not a mock. A second `/quarters` visit afterward correctly showed the
warning banner GONE (since `~/.cursor` now exists from the create step) - a nice confirmation the
`homeDirExists` check is live, not cached. Screenshot: `quarters-cursor-rules-after-delete.jpg`.

Console: no application errors (`read_console_messages`, pattern `error|Error|warn|Warn` — only the
same unrelated MetaMask extension warning seen in every prior gate's check).

## Known scope-downs (disclosed)

- `knownProjectRoots()` lists only `global_config.projects_root` children (default `~/dev`), NOT
  augmented with cwds the local Shells fitting's `/index` already knows about (the fuller design in
  the plan). Skipped to avoid a same-machine HTTP dependency inside a Quarters read path; the manual
  "type a path" fallback in `NewShellModal`-style UIs already covers the gap this would close. Noted
  in a code comment at the definition site.
- The mini rollout (section 4 of the plan - push `main`, `ssh` + merge + redeploy on
  `goncalos-mac-mini-1`, verify Cursor desktop sessions and a live `~/.cursor/rules` autosave there)
  is NOT done in this pass - it needs `main` pushed first, which is still blocked by F-000 (unrelated
  kanban-loop WIP from another process). Tracked, not silently dropped.

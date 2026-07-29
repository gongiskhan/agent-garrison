# CSG — the all-Cursor composition

Every lane runs on the **Cursor Agent CLI** (`cursor-agent`). `cursor-runtime` is
the PRIMARY engine hosting the operative loop, and every routing target is a
Cursor target, so no turn can silently land on Claude Code, Codex, Gemini or the
Agent SDK. Model variety comes from Cursor's own multi-lab catalog — one
subscription, one CLI, one credential.

Stationed: `orchestrator`, `http-gateway`, `dispatcher`, `cursor-runtime`,
`basic-memory`, `web-channel-default`, `identity-gary` — the seven that satisfy
every readiness rule (an orchestrator, a runtime, a channel, a memory store, a
gateway, an identity, a dispatch duty). Deliberately nothing beyond them: every
extra Fitting is another setup + verify hook between you and a running operative.

The channel is own-port and NOT eager, so `up` does not start it — start it from
Views, or `POST /api/fittings/web-channel-default/start`. It serves on the
composition's 7083 shifted by the profile offset (8083 on prod).

## Setup on a fresh box

1. **Log in to Cursor** — `cursor-agent login`. The runtime's verify hook probes
   *authentication*, not just the binary, so `up` fails loudly (with the fix in
   the message) rather than failing every turn later. The Fitting's setup hook
   links the real `~/.config/cursor` into the instance's `XDG_CONFIG_HOME`, which
   every Garrison profile redirects — without it a logged-in box reads as logged
   out inside an instance.

2. **Install the cursor-only routing policy.** `.garrison/routing.json` is
   machine-local (gitignored), so it seeds from the orchestrator Fitting's
   default — which names `claude-code-runtime` as primary and carries the stock
   Claude/Codex/Gemini/ollama targets. Copy the committed cursor-only policy over
   it before the first `up`:

   ```bash
   mkdir -p compositions/csg/.garrison
   cp compositions/csg/routing.cursor-only.json compositions/csg/.garrison/routing.json
   ```

   That file is this composition's live policy, captured: `primaryRuntime:
   cursor-runtime` and five Cursor targets, with every matrix row, exception and
   continuation remapped onto them. It was written through the real
   validate + compile path, not hand-edited.

   Without step 2 the composition still *routes* to Cursor (the duty cells in
   `apm.yml` name only `cursor-*` targets, and those are merged in at compile
   time), but the primary would be Claude Code and the stock non-Cursor targets
   would remain selectable — so it would no longer be "only Cursor".

   The equivalent through the UI: Muster → Fittings → make `cursor-runtime`
   primary; then prune the targets in the Policy panel.

3. `up` the composition. Ports follow the usual profile offsets (gateway 4777 on
   dev, 5777 on prod).

## Things that behave differently here

- **No effort control.** Cursor encodes reasoning effort in the model id
  (`gpt-5.3-codex-low` vs `-high`), so the duty cells carry a model and no
  `effort`, and a turn reports `effortApplied: false`. Escalating means routing to
  a heavier Cursor model, not raising a knob.
- **No account pin.** Cursor authenticates with its own login; there is no
  Garrison AccountPlatform for it, so the Fitting exposes no `account` key and its
  targets declare no `provider`. All instances on the box share the one Cursor
  identity.
- **The routing brain runs on Cursor too.** Both halves of it default to a second
  engine. The classifier defaults to a cheap Claude Code haiku session regardless
  of primary, gated on a PATH probe that says nothing about whether that CLI can
  spawn — on a box where it cannot (this instance's Claude config dir isn't logged
  in) the classifier fails to warm and *every* turn falls through unclassified to
  the default route, silently, unless you read the gateway log for
  `classify-failed`. And the Dispatcher calls through `garrison-call`, which
  speaks HTTP wire shapes only and so cannot reach a CLI engine at all. This
  composition sets the gateway's `routing_on_primary: true`, which pins both to
  the Cursor adapter. Verified live: prompts classified to `plan` / `code` /
  `other` and routed to `cursor-opus` / `cursor-fast` / `cursor-codex`.
- **The `dispatch` duty is declared, and the classifier is what actually routes.**
  The composition overrides the dispatcher Fitting's shipped `dispatch` duty
  (whose cell targets a `garrison-call` target this composition has no equivalent
  of) and repoints it at `cursor-fast`. Note the gateway's *v4 Dispatcher lane*
  additionally needs a projected execution model, which comes from the
  `kanban-loop` Fitting — not stationed here, so the gateway logs no
  `dispatcher-wired` and Stage-A classification remains the live routing path.
  That is the documented default anyway (MARATHON-V3 D6 retains the classifier
  session pending a live accuracy comparison); station `kanban-loop` if you want
  the board-driven duty pipeline.
- **Enforcement is advisory.** As with any non-Claude primary, PostToolUse/gate
  hooks become prompt guidance and resume is adapter-native (`--resume <chatId>`).
  See `docs/RUNTIME_DEGRADATIONS.md`.

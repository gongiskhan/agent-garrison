# GLM — the self-hosted, OpenAI-compatible composition

Every lane runs on **GLM 5.2 served from a self-hosted OpenAI-compatible
endpoint**. `openai-agents-runtime` is the PRIMARY engine hosting the operative
loop, and every routing target is a GLM target, so no turn can silently land on
Claude Code, Codex, Gemini, Cursor or the Agent SDK. Nothing here bills an
Anthropic plan.

Stationed: `orchestrator`, `http-gateway`, `openai-agents-runtime`,
`basic-memory`, `web-channel-default`, `orchestrator` — the fittings that satisfy
every readiness rule (an orchestrator, a runtime, a channel, a memory store, a
gateway, an identity, a dispatch duty). Deliberately nothing beyond them: every
extra Fitting is another setup + verify hook between you and a running operative.

The channel is own-port; it serves on the composition's 7083 shifted by the
profile offset (8083 on prod).

## Setup on a fresh box

1. **Add the key as an account.** `/accounts` → **GLM (self-hosted)** → add an
   account, paste the bearer token your endpoint accepts. It is sealed in the
   vault under `ACCOUNT__GLM__<name>` and injected at spawn as **`GLM_API_KEY`**.

   Then set that account name on the runtime: Muster → Fittings →
   `openai-agents-runtime` → `account`. (Or leave `account` empty and seal a
   plain vault secret literally named `GLM_API_KEY` — the runtime reads the key
   by name from the materialized vault either way.)

2. **Point the runtime at the endpoint.** The `baseUrl` in this manifest
   (`http://154.59.156.40:33532/v1`) is the TRUSTED endpoint. The runner projects
   it into `GLM_BASE_URL`, and the adapter attaches `GLM_API_KEY` only to a
   request that actually goes there — a routing target naming a *different* URL
   is served keyless rather than having the key shipped to it. So if the endpoint
   moves, change it here (or in the runtime's config in the UI); do not put it on
   a target.

3. **Confirm the GLM-only routing policy.** On the first `up` (or an explicit
   policy edit), Garrison atomically seeds the absent machine-local
   `.garrison/routing.json` from the committed `routing.glm-only.json`. It never
   overwrites an existing local policy, so changes made in Muster remain yours.
   Read-only screens preview the committed seed without modifying the checkout.

   The committed seed carries `primaryRuntime: openai-agents-runtime`, the `glm` provider
   entry (kind `cloud-oss`, with the endpoint and `vaultKey: GLM_API_KEY`), and
   four GLM targets with every matrix row, exception and continuation remapped
   onto them. It was written through the real validate path, not hand-edited.

   If an older machine already has a local policy, Garrison deliberately leaves
   it alone. Check that its `primaryRuntime` is `openai-agents-runtime`; remove or
   replace that local file manually only when you intentionally want to reset it
   from the committed GLM seed.

4. `up` the composition. Ports follow the usual profile offsets (gateway 4777 on
   dev, 5777 on prod).

## The three targets

All four ride the same endpoint and the same checkpoint — one box serves one
model — so they differ only in **harness shape**, which is the real cost knob
here:

| target | promptMode | maxTurns | for |
|---|---|---|---|
| `glm-fast` | lean | 4 | one-shot answers, Orchestrator routing inference, probes |
| `glm-standard` | full | 12 | ordinary bounded work, with the file toolset |
| `glm-deep` | full | 24 | wide-blast-radius work; more loop headroom |

`lean` disables the cwd-confined file tools and uses a minimal prompt (lowest
token floor); `full` enables `read_file` / `write_file` / `list_dir`, confined to
the session's working directory.

## Things that behave differently here

- **No effort control.** Plain `/v1/chat/completions` carries no reasoning-effort
  parameter, so `effortControllable` is false for this engine and a turn reports
  `effortApplied: false`. Escalating means a bigger harness (`glm-deep`), not
  raising a knob. Duty cells here declare no `effort` at all.

- **Routing stays native.** The explicit `dispatch` duty targets `glm-fast`, so
  this composition never needs a legacy primary-routing flag or a separate
  Anthropic classifier.

- **Session continuity is in-memory only.** This adapter carries the
  `@openai/agents` history thread across turns on a warm session, but there is no
  on-disk session id and no `--resume`: a gateway restart starts a fresh
  conversation. Claude-Code-shaped surfaces that assume a session transcript
  (Quarters deep tier, plans, session logs) degrade accordingly.

- **No vision, no MCP, no web search.** The provider's capability record is
  text + function tools only, so the orchestrator refuses to route an image or
  MCP block here rather than sending one the endpoint would drop. If your
  deployment does serve images, override `capabilities` per target.

- **No balance or usage surface.** A self-hosted box reports none, so the
  Accounts page shows no credit for a GLM account.

## Security note

The endpoint above is **plain `http://` on a public IP**. The bearer token and
every prompt and completion travel unencrypted, and anything on the path can read
them. Garrison will not stop you — the base-URL fence only checks that the key
goes to the URL you configured, not that the URL is safe. Prefer a tailnet
address or a TLS terminator in front of the box; if you keep plain HTTP, treat
that key as disposable and do not send anything you would not post publicly.

# Phase 0 Research — FINDING-E13 & FINDING-E15

Run: `20260712-173530-81e1c448`
Researcher: `explore-external`
Date: 2026-07-12
Method: WebFetch/WebSearch + locally installed `opencode` CLI v1.17.15 (live `opencode serve` OpenAPI probe). Facts only.

---

## TASK 1 — FINDING-E13: Leonxlnx/taste-skill

**Repo:** `Leonxlnx/taste-skill`, default branch `main`.
Description: "Taste-Skill - gives your AI good taste. stops the AI from generating boring, generic slop".
`pushed_at`: 2026-07-04T22:02:55Z.

### (a) LICENSE — pure MIT
Raw `LICENSE` (https://raw.githubusercontent.com/Leonxlnx/taste-skill/main/LICENSE) is the standard, unmodified MIT License text — all standard clauses intact, no added terms.
Copyright line: `Copyright (c) 2026 Leonxlnx`.
GitHub `/license` endpoint agrees: `spdx_id: MIT`, name "MIT License".
**Verdict: pure MIT. Safe to vendor with attribution.**

### (b) Sub-skill list
NOTE: the team lead's expected skill names (`design-taste-frontend` v2, `redesign-skill`) were partly stale as *directory* names. Skills live under `skills/<dir>/SKILL.md`. The `skills/` folder has 14 entries — 13 skill directories + one `skills/llms.txt` manifest. The **directory name differs from the SKILL.md `name:` install id**. Two rows below (`taste-skill`, `redesign-skill`) verified directly against raw SKILL.md frontmatter; the rest from the `skills/llms.txt` manifest + README.

| dir (`skills/`) | SKILL.md `name:` | what it is |
|---|---|---|
| `taste-skill` | **`design-taste-frontend`** (v2, experimental) | Default anti-slop frontend skill; reads brief, infers design language, tunes three dials. (frontmatter `description` verified verbatim) |
| `taste-skill-v1` | `design-taste-frontend-v1` | Original v1, preserved for projects pinned to its exact behavior. |
| `redesign-skill` | **`redesign-existing-projects`** | Audit-first upgrade of existing sites/apps; fixes generic AI patterns without breaking functionality. (frontmatter verified verbatim) |
| `gpt-tasteskill` | `gpt-taste` | Stricter GPT/Codex variant: higher layout variance, stronger GSAP motion direction. |
| `image-to-code-skill` | `image-to-code` | Image-first: generate premium site reference images, analyze, then implement code. |
| `imagegen-frontend-web` | (imagegen web) | Image-generation-only: website comps. Does NOT write code. |
| `imagegen-frontend-mobile` | (imagegen mobile) | Image-generation-only: mobile screens/flows. Does NOT write code. |
| `brandkit` | (brandkit) | Image-generation-only: brand-kit boards (logo, palette, type, identity). |
| `soft-skill` | `high-end-visual-design` | Expensive/soft UI: premium fonts, whitespace, depth, smooth animation. |
| `minimalist-skill` | `minimalist-ui` | Editorial Notion/Linear style, strict monochrome palette. |
| `brutalist-skill` | `industrial-brutalist-ui` (Beta) | Raw mechanical, Swiss type, extreme scale contrast. |
| `stitch-skill` | `stitch-design-taste` | Google Stitch-compatible semantic rules; optional `DESIGN.md` export. |
| `output-skill` | `full-output-enforcement` | Anti-laziness: no placeholder comments / skipped code blocks. |

Repo root also contains: `.claude-plugin/`, `.github/`, `assets/`, `examples/`, `research/`, `scripts/`, `CHANGELOG.md`, `README.md`, `skill.sh`. It is packaged as a **multi-skill Claude plugin**, not a single skill. If Garrison only wants the two design skills, vendor `skills/taste-skill` + `skills/redesign-skill` (both self-contained SKILL.md dirs).

### (c) Latest commit SHA (for upstream pinning)
`b17742737e796305d829b3ad39eda3add0d79060` — "docs(readme): restore vercel sponsor badge", 2026-07-04T22:02:52Z, author Leonxlnx <lexn.lin8@gmail.com>.
Prior commits `2433ae0750700bc50bc76cb604dcb9b3d50ecf46`, `129373df23fad4b1da8cefd3878470b126e017b2` — all README/docs churn; last substantive skill code predates these.

---

## TASK 2 — FINDING-E15: OpenCode integration surface (v1.17.15, verified locally)

Binary: `~/.nvm/versions/node/v20.19.4/bin/opencode`. Verified from the live CLI plus a real `opencode serve` OpenAPI 3.1 spec (162 paths).
Local auth: `~/.local/share/opencode/auth.json` has **0 credentials** — no providers logged in; `opencode models` lists only free opencode-hosted models (`opencode/big-pickle`, `opencode/deepseek-v4-flash-free`, `opencode/hy3-free`, `opencode/mimo-v2.5-free`, `opencode/nemotron-3-ultra-free`, `opencode/north-mini-code-free`). **A bridge must handle first-run auth.**

### (a) Headless one-shot run — `opencode run [message..]`
Verified flags:
- `-m, --model provider/model` (e.g. `anthropic/claude-sonnet-4`)
- `--agent <name>`, `--variant <high|max|minimal>` (provider-specific reasoning effort)
- `--format default|json` — **`--format json` emits raw JSON events** (machine-readable delegate path)
- `--auto` — **auto-approve all permissions not explicitly denied** ("dangerous!"); headless yolo mode
- Session control: `-c/--continue`, `-s/--session <id>`, `--fork`, `--title`, `--share`, `-f/--file <path>` (attach files)
- `--attach <url>` + `--port` + `-u/--username` / `-p/--password` (basic auth) — `run` can target an already-running server instead of spawning its own. One server can serve many `run` calls.
- Related: `opencode export [sessionID] [--sanitize]` dumps a session as JSON; `opencode session list|delete`; `opencode acp` (Agent Client Protocol server); `opencode attach <url>`.

### (b) Server mode — `opencode serve`
`opencode serve --port <n> --hostname 127.0.0.1 [--cors <origin>]`.
Defaults: **port 4096, hostname 127.0.0.1**.
Auth: env `OPENCODE_SERVER_PASSWORD` (+ `OPENCODE_SERVER_USERNAME`, default user `opencode`) → HTTP basic auth; unset ⇒ unsecured (logs a warning).
OpenAPI 3.1 spec: **`GET /doc`**. Health: `GET /global/health` → `{"healthy":true,"version":"1.17.15"}`.

**Two API generations are both live:** legacy flat routes + a newer **`/api/*` v2** set. Core verified endpoints:

- Sessions: `POST /session` (create) · `GET /session` · `GET/DELETE/PATCH /session/{id}` · `GET /session/{id}/children`. v2: `POST /api/session`, `GET /api/session/active`, `GET /api/session/{id}`.
- Prompt/messages: **`POST /session/{id}/message`** (= `session.prompt`, send-and-await) · **`POST /session/{id}/prompt_async`** (fire-and-forget) · `GET /session/{id}/message` (list). v2: `POST /api/session/{id}/prompt` + `POST /api/session/{id}/wait` (block for completion) + `POST /api/session/{id}/interrupt`.
- Streaming (SSE): **`GET /event`** (global bus) · **`GET /api/session/{id}/event`** (per-session) · `GET /global/event`.
- Permissions over HTTP: `GET /permission`, `POST /session/{id}/permissions/{permId}` (reply). v2: `POST /api/session/{id}/permission/{reqId}/reply`, `GET /api/permission/request`, `GET /api/permission/saved`. Elicitation: `GET /question` + reply/reject.
- Other: `GET /config` + `PATCH /config`, `GET /provider`, `GET /skill` + `GET /api/skill`, `GET /agent`, `POST /session/{id}/abort`, `POST /session/{id}/fork`, `GET /session/{id}/diff`, plus a full `/pty/*` terminal API and `/vcs/*` (status/diff/apply).

`POST /session/{id}/message` request body (from live spec): required `parts[]` (each a `TextPartInput` / `FilePartInput` / `AgentPartInput` / `SubtaskPartInput`); optional `model:{providerID,modelID}`, `agent`, `system` (per-prompt system override), `variant`, `tools:{<name>:bool}` (per-call tool gating), `format` (OutputFormat), `noReply`, `messageID`.

### (c) Session model
Persistent, server-side, addressable session ids. Create via `POST /session` (or implicitly on first `run`), resume via `-s/--session <id>` or `-c/--continue`, `--fork` to branch, `session.share`/`unshare`, `summarize`/`compact`, `revert`/`unrevert`. Sessions survive across `run` invocations and across attach — genuine long-lived state, not per-exec throwaway.

### (d) Permission model
Config under `permission` key in `opencode.json`; three actions `"allow" | "ask" | "deny"`; wildcard `"*"` default + per-tool override. Keys include: `read, edit, glob, grep, bash, task, skill, lsp, question, webfetch, websearch, external_directory, doom_loop`.
Headless yolo = **`--auto`** (approve everything not explicitly `deny`).
For unattended delegate runs: set `{"permission":{"*":"allow"}}` or pass `--auto`; keep `deny` on anything to hard-block. Over HTTP, prompts surface as `/permission` (or `/question`) requests answerable via the reply endpoints — a server bridge can auto-reply programmatically instead of `--auto`.

### (e) Providers
`anthropic` provider id; auth two ways:
1. **Claude Pro/Max OAuth** (`/connect` → Anthropic → "Claude Pro/Max" → browser login; no API key; mirrors Garrison's Max-account model, avoids API billing).
2. Manual API key.
Local models via **Ollama / any OpenAI-compatible** endpoint:
```json
{
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama (local)",
      "options": { "baseURL": "http://localhost:11434/v1" },
      "models": { "llama2": { "name": "Llama 2" } }
    }
  }
}
```
75+ providers via the AI SDK + models.dev integration. Nothing is authed on this box yet.

### Recommended bridge shape for a Garrison `opencode-runtime` Fitting
- **`delegate(task_spec)` one-shot ⇒ long-lived server, NOT CLI-per-task.** Boot one `opencode serve` (fixed `--hostname 127.0.0.1 --port <p>`, `OPENCODE_SERVER_PASSWORD` from Vault) under the own-port/operative-bound lifecycle. Per delegate: `POST /session` → `POST /api/session/{id}/prompt` (with `model`, `agent`, `system`, `tools`) → block on `POST /api/session/{id}/wait` (or consume `GET /api/session/{id}/event` SSE for streaming) → read messages / `session.diff`. Auto-answer `/permission` server-side (or run config `permission:{"*":"allow"}`). Gives session persistence, structured events, per-call tool/permission gating, one warm process instead of Node cold-start per task.
- **Primary interactive session ⇒ same server.** Attach a TUI/terminal via `opencode attach <url>` or drive `/pty/*`; interactive session is just another session id on the shared server, so delegate + interactive coexist.
- **Cheaper fallback (CLI-exec):** `opencode run "<spec>" -m anthropic/<model> --agent <a> --format json --auto` — single process, prints JSON events, exits. Good for a stateless one-shot with zero server management, but re-pays Node cold-start per task and loses the shared warm session pool.

### vs codex-runtime
A Codex bridge is inherently CLI-exec — `codex exec "<prompt>"` shells out, runs to completion, prints result, exits; no persistent HTTP server, session id, or SSE (state via `codex exec resume` / rollout files only). So natural shapes differ:
- **Codex = per-task subprocess (`codex exec`)**
- **OpenCode's best fit = a standing HTTP server** (`opencode serve` + HTTP API). OpenCode *also* offers the `opencode run` subprocess form matching Codex, but that gives up its main advantage.

If Garrison wants one uniform runtime interface, `opencode run --format json --auto` is the apples-to-apples analog of `codex exec`; if it wants a richer delegate with live events + warm sessions, use `opencode serve` + the HTTP API.

---

## Sources
- Local `opencode --help` and `run|serve|session|agent|acp --help` (v1.17.15)
- Live `opencode serve` OpenAPI at `GET /doc` (162 paths)
- https://opencode.ai/docs/server/ , https://opencode.ai/docs/permissions/ , https://opencode.ai/docs/providers/
- GitHub API `repos/Leonxlnx/taste-skill` (+ `/contents`, `/commits`, `/license`) and raw `SKILL.md` / `LICENSE` / `skills/llms.txt` on `main`

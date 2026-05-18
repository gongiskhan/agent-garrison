# Brief — `mcp-gateway` Fitting: expose Garrison Faculties to workbench-launched Claude Code sessions

## Context

The workbench launches Claude Code sessions against worktrees, including worktrees on remote machines. Those sessions currently run without any Garrison Faculties available. Until the orchestrator is worktree-aware, multi-machine-aware, and session-feedback-aware, sessions should still be able to reach selected Faculties — starting with the **tier-classifier** and **testing** Faculties — through a dedicated bridge.

This brief specifies a new `mcp-gateway` Fitting that exposes installed Faculties as MCP tools, plus the workbench wiring that injects that gateway into each launched Claude Code session.

## Locked decisions (do not re-open)

- **Bridge mechanism:** MCP. Each exposed Faculty becomes one or more MCP tools that Claude Code calls directly. No orchestrator in the loop for workbench-launched sessions.
- **Sibling, not overload:** The new `mcp-gateway` Fitting is separate from `http-gateway`. `http-gateway` keeps its single responsibility (running Claude in-process for the chat UI).
- **Both transports:** stdio MCP for same-machine worktrees; HTTP MCP for remote-machine worktrees. Same Fitting, transport selected at spawn time.
- **Initial Faculty surface:** `tier-classifier` and `testing` only. The wrapping pattern must accommodate more Faculties later, but do not pre-build wrappers for Faculties not listed.
- **Policy lives in the prompt:** A short `CLAUDE.md` fragment (or system prompt append) tells the model when to call these tools. The MCP server is the *capability*; the prompt is the *policy*.
- **Workbench is the launcher:** The workbench is responsible for spawning the gateway and writing the per-session MCP config Claude Code consumes. Claude Code is not modified.
- **No state in the bridge:** The gateway is a thin wrapper over existing Faculty scripts/endpoints. It does not introduce new persistence.

## Out of scope for this brief

- Orchestrator integration with worktrees / multi-machine / session feedback (a future milestone owns that).
- Cross-session memory between Claude Code sessions.
- Exposing Faculties beyond `tier-classifier` and `testing`.
- Any change to `http-gateway`.
- Authentication beyond a per-session shared token for the HTTP transport.

---

## Phase 1 — Audit existing Faculty implementations

Before writing the bridge, establish ground truth.

1. Locate the `tier-classifier` Fitting and the `testing` Fitting in the current Fittings tree. Record their paths.
2. For each, document:
   - What interface they currently expose (CLI script(s), HTTP endpoint(s), or both).
   - The exact invocation contract: arguments, stdin, environment variables, exit codes, output schema (stdout JSON, etc.).
   - Any probe / health command (e.g. `--probe`) and what success looks like.
   - Dependencies and runtime assumptions (Node version, working directory, file paths).
3. Identify the smallest stable surface to expose through MCP. Prefer the script-based contract if both exist — it has fewer moving parts.
4. **Verification:** Run each Faculty's probe (or equivalent) directly from the shell and capture the output in the audit notes. Run one representative classification and one representative test invocation; capture inputs and outputs verbatim. Do not proceed to Phase 3 until both Faculties respond correctly when called directly.

Deliverable: a short audit note (markdown, in the working branch) capturing the above. No code changes in this phase.

---

## Phase 2 — Audit the workbench launch path

1. Locate the workbench code that spawns Claude Code against a worktree. Record:
   - How the worktree is selected and how its path (local or remote) is resolved.
   - How Claude Code is currently invoked (binary path, arguments, working directory, environment).
   - The same-machine vs remote-machine code paths and how they differ.
   - Whether per-session config files are already written anywhere (e.g. `.claude/`, `CLAUDE.md`, MCP config).
2. Identify the single insertion point where MCP config injection will happen for both same-machine and remote-machine launches.
3. **Verification:** Trace one same-machine launch and one remote-machine launch end-to-end in the audit note. Confirm the insertion point handles both without branching the gateway-spawn logic.

Deliverable: appended to the audit note from Phase 1.

---

## Phase 3 — Build the `mcp-gateway` Fitting

Create a new Fitting at the conventional Fittings path. It must:

1. **Manifest:** Declare itself via the `x-garrison` block in `apm.yml`. `provides`: an `mcp-gateway` capability (new). `consumes`: declarations for the Faculties whose tools it surfaces (`tier-classifier`, `testing` for v1).
2. **Two transports, one binary:**
   - `mcp-gateway stdio` — speaks MCP over stdio. Used when the gateway is spawned by Claude Code itself (same-machine worktrees) or as a child of the workbench launcher.
   - `mcp-gateway http --port N --token T` — speaks MCP over HTTP. Used for remote worktrees where Claude Code on the remote machine connects back to the gateway on the workbench host.
3. **Tool surface (v1):**
   - From `tier-classifier`: one tool named exactly `classify_tier`. Inputs and outputs mirror the audited script contract — pass through, do not reshape.
   - From `testing`: one tool named exactly `run_tests`. Inputs and outputs mirror the audited script contract — pass through, do not reshape.
   - Tool descriptions are short, imperative, and state what the tool does in one sentence. No marketing.
4. **Invocation:** Each tool call shells out to the underlying Faculty script with the audited contract. Stdout is parsed (JSON if applicable, raw text otherwise) and returned as the MCP tool result. Non-zero exit codes surface as MCP tool errors with the stderr included.
5. **Health:** `mcp-gateway --probe` exits 0 if both underlying Faculty probes pass; non-zero otherwise. Required for the workbench to verify the gateway came up before handing the worktree to Claude Code.
6. **Security (HTTP only):** A shared bearer token, generated per session by the workbench, required on every request. No token, no service.
7. **No state:** The gateway holds no per-session memory and no cross-call caches. Each tool call is independent.

**Verification:**
- `mcp-gateway --probe` returns 0 on a composition with `tier-classifier` and `testing` installed.
- An MCP client (the project's preferred test client, or a minimal script) connects over stdio, lists tools, and successfully calls `classify_tier` and `run_tests` with realistic inputs. Outputs match the Phase 1 direct-invocation outputs byte-for-byte where deterministic.
- Same verification over HTTP transport with token auth, on localhost.

---

## Phase 4 — Workbench wiring

At the insertion point identified in Phase 2:

1. When a Claude Code session is launched against a worktree:
   - **Same-machine:** Write an MCP server entry into the per-session Claude Code config that spawns `mcp-gateway stdio` as a child process with the working directory set to the composition root.
   - **Remote-machine:** Start `mcp-gateway http` on the workbench host on an ephemeral port, generate a per-session token, and write an MCP server entry in the remote Claude Code config pointing at `http://<workbench-host>:<port>` with the token. Tear the gateway down when the session ends.
2. Drop a small `CLAUDE.md` fragment (or system prompt append, whichever the launch path already supports) into the worktree that names the two tools and gives one-line guidance on when to use each. Keep it under 20 lines — the model is competent; this is policy, not a manual.
3. Surface the chosen Faculties and transport in the workbench UI for the session so the user can confirm what's wired in before launching.

**Verification:**
- Launch a same-machine session against a real worktree. From inside the Claude Code session, list MCP tools and confirm `classify_tier` and `run_tests` are present. Call each once; confirm the outputs match Phase 3 outputs.
- Repeat for a remote-machine session against a real remote worktree.
- Kill the Claude Code session mid-flight; confirm the HTTP gateway process is reaped and the token is invalidated.

---

## Phase 5 — Smoke pass

1. Launch one of each (same-machine, remote-machine) and walk through a realistic mixed task: ask Claude Code to classify a tier and to run a test. Confirm both happen via the MCP tools (not by Claude Code synthesizing answers).
2. Stop and restart the workbench. Launch a new session. Confirm fresh sessions get a fresh gateway with a fresh token; no leftover state.
3. Uninstall the `testing` Fitting from the composition. Launch a new session. Confirm `run_tests` is absent from the tool list and `classify_tier` still works — the gateway must degrade gracefully when a consumed Faculty is missing.

---

## Deliverables

- One audit note (Phase 1 + Phase 2 appended).
- One new Fitting: `mcp-gateway`, with manifest, both transports, probe, and tool wrappers for `classify_tier` and `run_tests`.
- Workbench changes at the single insertion point identified in Phase 2.
- A short `CLAUDE.md` fragment template used at session launch.
- Verification evidence (captured outputs) for every phase's verification step, appended to the audit note.

## Notes for the implementing agent

- Do not modify `http-gateway`. If you find yourself reaching into it, stop and reconsider — `mcp-gateway` is a sibling.
- Do not introduce orchestrator routing. Workbench-launched sessions bypass the orchestrator by design for this milestone.
- Do not pre-build wrappers for Faculties not listed in this brief. The pattern should generalize; the v1 surface should not.
- If the audited Faculty contracts are inconsistent with what this brief assumes, stop and report the delta before changing either side.

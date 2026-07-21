// Automations run engine. Iterates an automation's steps, executes each
// (non-browser steps here; browser/verify wired by the F-group orchestration via
// deps.runBrowser), emits live events, and persists a run record. The fixer loop
// (G1s) and pause/consent (G2s) layer on top via the same emitter + deps.
//
// Event names mirror the brief's SSE set (E3 maps these to the SSE stream):
//   run_step, run_complete, run_error, run_patch, run_pause_for_user,
//   run_resumed, run_awaiting_consent, run_awaiting_connector,
//   step_output_chunk, run_streaming_available

import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { interpolate, interpolateDeep } from "./template-vars.mjs";
import { saveRun, getAutomation, writeStepEvidence, saveMatrixRun } from "./store.mjs";
import { ulid } from "./ulid.mjs";
import { redactDeep } from "./redact.mjs";
import { makeBrowserClient } from "./browser-client.mjs";
import { runBrowserStep } from "./browser-orchestrator.mjs";
import { REHEARSAL_BUDGET, detectHumanActionable, applyPatch, proposePatch, validatePatch } from "./fixer.mjs";
import { shapeForStep, isShapeApproved, approveShape } from "./command-shape.mjs";
import { needsRemoteProbe, evaluateTextContains, evaluateUrlMatches } from "./assertions.mjs";

const BROWSER_STEP_TYPES = new Set(["browser", "verify", "navigate"]);

function normalizeFailure(error, step, recoverable) {
  const declared = error?.failure;
  if (declared && ["product", "infrastructure", "unknown"].includes(declared.class)) {
    return {
      class: declared.class,
      component: String(declared.component || (declared.class === "product" ? "app" : "automations")),
      code: String(declared.code || `${declared.class}-failure`),
      retryable: declared.retryable === true
    };
  }
  if (recoverable) {
    return {
      class: "product",
      component: "app",
      code: `${step.type || "browser"}-interaction-failed`,
      retryable: false
    };
  }
  if (BROWSER_STEP_TYPES.has(step.type)) {
    return {
      class: "infrastructure",
      component: "browser",
      code: "browser-runtime-failure",
      retryable: true
    };
  }
  return {
    class: "unknown",
    component: "automations",
    code: `${step.type || "step"}-unclassified-failure`,
    retryable: false
  };
}

function nowIso() {
  return new Date().toISOString();
}

// ── default executors (overridable via deps for tests) ──────────────────────

// Resolve a connector's scoped auth env from the Garrison backend (which owns the
// Vault). api_key connectors get their scoped secrets; oauth2 connectors get a
// freshly-refreshed <SERVICE>_ACCESS_TOKEN. The token never returns to a log.
function internalToken() {
  try {
    const home = process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
    const file = process.env.GARRISON_INTERNAL_TOKEN_PATH || path.join(home, "internal-token");
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

async function defaultConnectorAuthEnv(connectorId, fetchImpl) {
  const base = process.env.GARRISON_BASE_URL || "http://127.0.0.1:27777";
  const res = await fetchImpl(`${base}/api/connectors/${encodeURIComponent(connectorId)}/auth-env`, {
    method: "POST",
    headers: { "x-garrison-internal": internalToken() }
  });
  if (!res.ok) {
    if (res.status === 409) return { __awaiting_connector: true };
    throw new Error(`connector auth-env ${connectorId}: ${res.status}`);
  }
  const json = await res.json();
  return json.env ?? {};
}

// Spawn the connector Fitting's uniform connector.mjs with the scoped auth env.
function defaultRunConnector({ scriptPath, action, args, authEnv }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, "call", action, JSON.stringify(args ?? {})], {
      env: { ...process.env, ...authEnv },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c.toString()));
    child.stderr.on("data", (c) => (err += c.toString()));
    child.on("close", () => {
      try {
        resolve(JSON.parse(out.trim()));
      } catch {
        resolve({ ok: false, error: err.trim() || out.trim() || "connector produced no JSON" });
      }
    });
    child.on("error", (e) => resolve({ ok: false, error: e.message }));
  });
}

function defaultRunCommand({ command, argv, cwd, timeoutMs = 300000, onChunk }) {
  return new Promise((resolve) => {
    const child = argv
      ? spawn(argv[0], argv.slice(1), { cwd: cwd || os.homedir(), stdio: ["ignore", "pipe", "pipe"] })
      : spawn("/bin/sh", ["-c", command], { cwd: cwd || os.homedir(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (c) => {
      const s = c.toString();
      stdout += s;
      onChunk?.({ stream: "stdout", chunk: s });
    });
    child.stderr.on("data", (c) => {
      const s = c.toString();
      stderr += s;
      onChunk?.({ stream: "stderr", chunk: s });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + e.message, exitCode: -1 });
    });
  });
}

// Per-step vision/fixer model call, routed through the backend Model Router.
// contextTag (opt-in, e.g. "drill-adversarial") becomes part of the routed
// classification's contextKind, so a composition's routing config can target
// it at a different model than the caller's default vision resolution — the
// mechanism R12's "a different model set in the composition" needs, with no
// caller-specific naming baked into the engine itself.
async function visionResolve(observation, step, mode, contextTag, fetchImpl = globalThis.fetch, onMeta = null) {
  const base = process.env.GARRISON_BASE_URL || "http://127.0.0.1:27777";
  let res;
  try {
    res = await fetchImpl(`${base}/api/automations/vision`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-garrison-internal": internalToken() },
      body: JSON.stringify({ observation, step, mode, contextTag })
    });
  } catch (cause) {
    const error = new Error(`vision connection failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    error.failure = { class: "infrastructure", component: "vision", code: "vision-transport", retryable: true };
    error.recoverable = false;
    throw error;
  }
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      if (typeof body?.error === "string") detail = body.error.trim();
    } catch {
      // The status still carries the stable machine-readable failure code.
    }
    const error = new Error(`vision ${res.status}${detail ? `: ${detail}` : ""}`);
    error.failure = { class: "infrastructure", component: "vision", code: `vision-http-${res.status}`, retryable: res.status >= 500 };
    error.recoverable = false;
    throw error;
  }
  try {
    const json = await res.json();
    if (!json || !Object.prototype.hasOwnProperty.call(json, "result")) {
      throw new Error("vision response did not include result");
    }
    // Session linkage: the vision route names the Claude session (and jsonl
    // transcript) that produced this resolution — surfaced via onMeta so the
    // step record can carry it without changing the result contract.
    if (onMeta && (json.sessionId || json.transcriptPath)) {
      onMeta({
        sessionId: json.sessionId ?? null,
        transcriptPath: json.transcriptPath ?? null,
        routedVia: json.routedVia ?? null
      });
    }
    return json.result;
  } catch (cause) {
    const error = new Error(`vision invalid response: ${cause instanceof Error ? cause.message : String(cause)}`);
    error.failure = { class: "infrastructure", component: "vision", code: "vision-invalid-response", retryable: true };
    error.recoverable = false;
    throw error;
  }
}

// The live runBrowser: lazily opens ONE browser tab per run, then routes each
// browser/verify/navigate step through the cache->vision->execute orchestration.
// Replaces the E2 throwing stub. Tests still inject deps.runBrowser to stay
// browser-free. `viewport` (delta 3) is applied at tab creation; `bypassCache`
// (delta 2) is threaded straight into runBrowserStep; `contextTag` (delta 1)
// flows into every vision call's classification.
function makeLiveRunBrowser(automation, { viewport = null, bypassCache = false, contextTag = null, captureSession = null } = {}) {
  let client = null;
  const runBrowser = async ({ step, emit, runId, stepIndex }) => {
    client ??= makeBrowserClient({ viewport, captureSession });
    emit?.({ type: "run_streaming_available", runId, stepIndex, wsUrl: `${browserViewportUrl()}/${client.tabId ?? ""}` });
    // Per-step vision session linkage: the LAST vision call's session meta is
    // attached to the step result (success) or the thrown error (failure) so
    // the run record can trace each resolution to its Claude session.
    let visionMeta = null;
    const noteVisionMeta = (meta) => {
      if (meta && (meta.sessionId || meta.transcriptPath)) visionMeta = meta;
    };
    try {
      const result = await runBrowserStep({
        automationId: automation.id,
        step,
        bypassCache,
        deps: {
          observe: () => client.observe({ screenshot: true }),
          executeAction: (a) => client.execute(a),
          navigate: (u) => client.navigate(u),
          resolveViaVision: ({ observation, step: s }) =>
            visionResolve(observation, s, "action", contextTag, undefined, noteVisionMeta),
          verifyViaVision: ({ observation, step: s }) =>
            visionResolve(observation, s, "verify", contextTag, undefined, noteVisionMeta),
          // Richer deterministic assertions (delta 5): text-contains/url-matches
          // resolve locally from observe(); count/visible/attribute-equals need a
          // live Playwright locator, resolved by the Browser fitting.
          executeAssertion: async (assertion) => {
            const kind = assertion?.kind || "text-contains";
            if (kind === "url-matches") return evaluateUrlMatches(assertion, await client.observe());
            if (needsRemoteProbe(kind)) return !!(await client.assert(assertion)).passed;
            return evaluateTextContains(assertion, await client.observe());
          }
        }
      });
      return visionMeta && result && typeof result === "object"
        ? { ...result, vision: visionMeta }
        : result;
    } catch (err) {
      if (visionMeta && err && typeof err === "object" && !err.visionMeta) {
        err.visionMeta = visionMeta;
      }
      throw err;
    }
  };
  runBrowser.close = async () => {
    if (!client) return;
    const closing = client;
    client = null;
    await closing.close();
  };
  return runBrowser;
}

function browserViewportUrl() {
  return process.env.GARRISON_BROWSER_URL || "http://127.0.0.1:27084/viewport";
}

// ── the run loop ────────────────────────────────────────────────────────────

export async function runAutomation(opts) {
  const {
    automation,
    inputs = {},
    event = {},
    triggeredBy = "user",
    runId = ulid(),
    emit = () => {},
    visited = new Set(),
    // contextTag (delta 1): a caller-supplied label carried on the run record
    // (e.g. "drill" or "drill-adversarial") — generic plumbing, no drill-
    // specific naming here (Garrison Honesty Test; the label is data, not code).
    contextTag = null,
    // bypassCache (delta 2, R12): forwarded to the browser orchestration.
    bypassCache = false,
    // viewport (delta 3): applied when the live browser client opens its tab.
    viewport = null,
    // captureSession (delta 8): opaque caller-minted id forwarded to the
    // Browser fitting at tab creation so the caller (e.g. Drill) can group
    // this run's tab into a recorded capture context. Generic plumbing — the
    // engine never interprets it and it is not part of the run record.
    captureSession = null,
    // ephemeral (delta 1): true for a run whose `automation` was never saved to
    // the store — informational only, changes no engine behavior.
    ephemeral = false,
    deps = {}
  } = opts;

  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const connectorAuthEnv = deps.connectorAuthEnv || ((id) => defaultConnectorAuthEnv(id, fetchImpl));
  const runConnector = deps.runConnector || defaultRunConnector;
  const runCommand = deps.runCommand || defaultRunCommand;
  const runBrowser = deps.runBrowser || makeLiveRunBrowser(automation, { viewport, bypassCache, contextTag, captureSession });
  const runSubAutomation = deps.runSubAutomation;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const persist = deps.persist || saveRun;
  // Human-in-the-loop resume: when the engine pauses (CAPTCHA, awaiting_connector,
  // command consent), it awaits this. Resolves { resumed, decision } when the user
  // acts. Absent (headless) => the pause is terminal (the run returns paused).
  const waitForResume = deps.waitForResume || null;

  // Emit + persist a pause; if a resume capability exists, await it and return the
  // user's decision so the engine can retry the paused step.
  const pauseAndAwait = async ({ status, pauseInfo, event }) => {
    // Per-pause nonce: the resume must present THIS nonce, so a stale/duplicate
    // resume can't approve a later, different pause in the same run.
    const nonce = ulid();
    pauseInfo.nonce = nonce;
    event.nonce = nonce;
    record.status = status;
    record.pause = pauseInfo;
    record.endedAt = nowIso();
    await persist(record);
    safeEmit(event);
    if (!waitForResume) return { resumed: false };
    const r = await waitForResume(pauseInfo);
    if (r && r.resumed) {
      record.status = "running";
      delete record.endedAt;
      delete record.pause;
      safeEmit({ type: "run_resumed", runId, stepIndex: pauseInfo.stepIndex });
      return { resumed: true, decision: r.decision };
    }
    return { resumed: false };
  };

  const scope = { input: inputs, capture: {}, event };
  // Every connector/api auth value injected during the run is collected here and
  // scrubbed from anything PERSISTED or EMITTED (in-memory `capture` stays raw so
  // downstream {{capture.*}} interpolation still works).
  const secretValues = new Set();
  const collect = (env) => {
    for (const v of Object.values(env || {})) if (typeof v === "string" && v) secretValues.add(v);
  };
  const safeEmit = (ev) => emit(redactDeep(ev, secretValues));
  const record = {
    id: runId,
    automationId: automation.id,
    startedAt: nowIso(),
    status: "running",
    triggeredBy,
    inputs,
    contextTag,
    ephemeral,
    viewport: viewport ?? null,
    steps: []
  };
  const finishTerminalRun = async () => {
    try {
      if (typeof runBrowser.close === "function") await runBrowser.close();
    } catch {
      // Browser cleanup is best-effort and must never rewrite the run outcome.
    }
    return record;
  };

  // Mutable working steps + fixer budget (the self-healing loop applies patches
  // in place and retries at the same index).
  const steps = automation.steps.slice();
  const fixerFn = deps.proposePatch || proposePatch;
  const patchesPerIndex = {};
  let fixerCalls = 0;
  let pauses = 0;
  const fixStart = Date.now();
  let i = 0;
  while (i < steps.length) {
    const step = steps[i];
    const resolved = interpolateDeep(step, scope);

    // Step enable flags (delta 4): a disabled step is skipped, not removed, so
    // Drill's checkbox toggle needs no re-plan/re-compile round trip.
    if (resolved.enabled === false) {
      const rec = { stepIndex: i, stepId: step.id, type: step.type, status: "skipped", tier: "skipped", durationMs: 0 };
      record.steps.push(rec);
      safeEmit({ type: "run_step", runId, stepIndex: i, stepId: step.id, stepType: step.type, status: "skipped", tier: "skipped" });
      i += 1;
      continue;
    }

    const stepStart = Date.now();
    safeEmit({ type: "run_step", runId, stepIndex: i, stepId: step.id, stepType: step.type, status: "running" });

    try {
      let result;
      let tier = "execute";
      if (BROWSER_STEP_TYPES.has(step.type)) {
        result = await runBrowser({ step: resolved, scope, emit: safeEmit, runId, stepIndex: i });
        tier = result?.tier ?? "vision";
      } else if (step.type === "wait") {
        const ms = Number(resolved.durationMs ?? resolved.duration_ms ?? 0);
        await sleep(ms);
        result = { waitedMs: ms };
      } else if (step.type === "local_command") {
        // Consent: the first use of each command SHAPE needs approval.
        const shape = shapeForStep(resolved);
        if (shape && !(await isShapeApproved(shape))) {
          const r = await pauseAndAwait({
            status: "awaiting_consent",
            pauseInfo: { kind: "awaiting_consent", stepIndex: i, shape, argv: resolved.argv, command: resolved.command },
            event: { type: "run_awaiting_consent", runId, stepIndex: i, shape, argv: resolved.argv, description: `run \`${shape}\`` }
          });
          if (!r.resumed) return record; // user stopped, or headless (terminal pause)
          if (r.decision === "always") await approveShape(shape);
          else if (r.decision !== "once") throw new Error(`command not approved: ${shape}`);
        }
        result = await runCommand({
          command: resolved.command,
          argv: resolved.argv,
          cwd: resolved.cwd,
          timeoutMs: resolved.timeoutMs,
          onChunk: (c) => safeEmit({ type: "step_output_chunk", runId, stepIndex: i, ...c })
        });
        if (result.exitCode !== 0) throw new Error(`command exited ${result.exitCode}: ${(result.stderr || "").slice(0, 400)}`);
      } else if (step.type === "api_call") {
        result = await execApiCall(resolved, { fetchImpl, connectorAuthEnv, collect });
      } else if (step.type === "connector") {
        const connectorId = resolved.connector;
        const authEnv = await connectorAuthEnv(connectorId);
        if (authEnv.__awaiting_connector) {
          const r = await pauseAndAwait({
            status: "awaiting_connector",
            pauseInfo: { kind: "awaiting_connector", stepIndex: i, service: connectorId },
            event: { type: "run_awaiting_connector", runId, stepIndex: i, service: connectorId }
          });
          if (!r.resumed) {
            record.awaitingConnector = { stepIndex: i, service: connectorId };
            return record;
          }
          continue; // retry the connector step now that it is connected
        }
        collect(authEnv);
        const cres = await runConnector({
          connectorId,
          // Server-resolved script path ONLY — never a YAML-supplied override, so
          // an automation can't borrow a connector's auth and run arbitrary code.
          scriptPath: connectorScriptPath(connectorId),
          action: resolved.action,
          args: resolved.args ?? {},
          authEnv
        });
        if (cres && cres.awaiting_connector) {
          const r = await pauseAndAwait({
            status: "awaiting_connector",
            pauseInfo: { kind: "awaiting_connector", stepIndex: i, service: connectorId },
            event: { type: "run_awaiting_connector", runId, stepIndex: i, service: connectorId }
          });
          if (!r.resumed) {
            record.awaitingConnector = { stepIndex: i, service: connectorId };
            return record;
          }
          continue;
        }
        if (!cres || cres.ok === false) throw new Error(`connector ${connectorId}.${resolved.action}: ${cres?.error ?? "failed"}`);
        result = cres.result;
      } else if (step.type === "sub_automation") {
        if (!runSubAutomation) throw new Error("sub_automation requires runSubAutomation (set by the engine host)");
        result = await runSubAutomation({ id: resolved.sub_automation_id, inputs: resolved.args ?? {}, visited });
      } else {
        throw new Error(`unsupported step type: ${step.type}`);
      }

      // Per-step evidence (delta 7, R13): a browser/verify/navigate step may
      // carry back a screenshot already fetched during resolution — write it as
      // a plain file with a link and strip the base64 before it reaches
      // scope.capture/the persisted record/the SSE stream.
      let evidencePath = null;
      if (result?.evidence?.screenshotB64) {
        try {
          evidencePath = await writeStepEvidence(runId, i, result.evidence.screenshotB64);
        } catch { /* evidence capture is best-effort; never fails the step */ }
        delete result.evidence;
      }

      // Capture the RAW result for downstream {{capture.<stepId>}}; persist +
      // emit a redacted copy (no injected secret/token reaches disk or the SSE).
      scope.capture[step.id] = result;
      const safeResult = redactDeep(result, secretValues);
      const rec = { stepIndex: i, stepId: step.id, type: step.type, status: "completed", tier, durationMs: Date.now() - stepStart, result: safeResult, ...(evidencePath ? { evidencePath } : {}) };
      record.steps.push(rec);
      safeEmit({ type: "run_step", runId, stepIndex: i, stepId: step.id, stepType: step.type, status: "completed", tier, durationMs: rec.durationMs, result: result, ...(evidencePath ? { evidencePath } : {}) });
      i += 1;
    } catch (err) {
      const safeMsg = redactDeep(err.message, secretValues);
      let failureEvidencePath = null;
      if (err.evidenceScreenshotB64) {
        try {
          failureEvidencePath = await writeStepEvidence(runId, i, err.evidenceScreenshotB64);
        } catch { /* evidence capture is best-effort; never masks the failure */ }
      }
      // Only page-level failures (marked recoverable by the orchestrator) enter
      // the fixer — an infrastructure failure (Browser Fitting down) fails fast.
      const recoverable = err.recoverable === true;

      // Fast-path: an obvious human-action page (CAPTCHA/MFA/payment/identity)
      // pauses immediately for the user (resume wired in G2s).
      const human = recoverable ? detectHumanActionable(safeMsg) : null;
      if (human && pauses < REHEARSAL_BUDGET.maxNormalPauses) {
        pauses += 1;
        const r = await pauseAndAwait({
          status: "paused_for_user",
          pauseInfo: { kind: "pause_for_user", stepIndex: i, reasoning: human.reasoning, userInstructions: human.userInstructions },
          event: { type: "run_pause_for_user", runId, stepIndex: i, reasoning: human.reasoning, userInstructions: human.userInstructions }
        });
        if (!r.resumed) return record;
        continue; // user acted (solved the CAPTCHA/MFA) — retry the step
      }

      // Budget gates: only browser-recoverable failures enter the fixer, and only
      // within the rehearsal budget. Anything else fails the run.
      const overBudget =
        !recoverable ||
        fixerCalls >= REHEARSAL_BUDGET.maxFixerCalls ||
        (patchesPerIndex[i] ?? 0) >= REHEARSAL_BUDGET.maxPatchesPerIndex ||
        Date.now() - fixStart > REHEARSAL_BUDGET.maxWallClockMs;
      if (overBudget) {
        const failure = normalizeFailure(err, step, recoverable);
        const rec = {
          stepIndex: i,
          stepId: step.id,
          type: step.type,
          status: "failed",
          durationMs: Date.now() - stepStart,
          error: safeMsg,
          failure,
          ...(err.visionMeta ? { vision: err.visionMeta } : {}),
          ...(failureEvidencePath ? { evidencePath: failureEvidencePath } : {})
        };
        record.steps.push(rec);
        record.status = "failed";
        record.endedAt = nowIso();
        record.error = safeMsg;
        record.failure = failure;
        await persist(record);
        safeEmit({ type: "run_error", runId, stepIndex: i, error: safeMsg, failure });
        return finishTerminalRun();
      }

      // Propose ONE patch, apply it, and retry at the same index.
      fixerCalls += 1;
      patchesPerIndex[i] = (patchesPerIndex[i] ?? 0) + 1;
      const failureKind = step.type === "verify" ? "verify_failed" : step.type === "navigate" ? "navigate_failed" : "browser_failed";
      safeEmit({ type: "run_patch", runId, stepIndex: i, phase: "proposing", failureKind, failureMessage: safeMsg });
      let patch;
      try {
        const observation = deps.fixObserve ? await deps.fixObserve() : {};
        // Re-validate at the engine boundary so an injected fixer can't bypass the
        // FIXER_ALLOWED_STEP_TYPES allowlist (no shell/connector escalation).
        patch = validatePatch(await fixerFn({ step, error: safeMsg, observation, failureKind }));
      } catch (e) {
        // An unusable fixer reply (model drifted off the patch grammar, fixer
        // endpoint down) is a failed FIX ATTEMPT, not a new failure mode: the
        // step fails with its ORIGINAL error - "unknown patch kind: hover" must
        // never mask the verify failure the report needs to show (live-fire
        // 2026-07-17: a vision model replied with an action instead of a patch
        // and every such step surfaced as a fixer crash instead of a finding).
        const fixerNote = `fixer unusable: ${redactDeep(e.message, secretValues)}`;
        const failure = normalizeFailure(err, step, recoverable);
        const recoveryFailure = e?.failure && ["product", "infrastructure", "unknown"].includes(e.failure.class)
          ? normalizeFailure(e, step, false)
          : {
              class: "infrastructure",
              component: "fixer",
              code: "fixer-invalid-response",
              retryable: true
            };
        record.status = "failed";
        record.endedAt = nowIso();
        record.error = safeMsg;
        record.failure = failure;
        record.recoveryFailure = recoveryFailure;
        record.steps.push({
          stepIndex: i,
          stepId: step.id,
          type: step.type,
          status: "failed",
          durationMs: Date.now() - stepStart,
          error: safeMsg,
          fixerNote,
          failure,
          recoveryFailure,
          ...(err.visionMeta ? { vision: err.visionMeta } : {}),
          ...(failureEvidencePath ? { evidencePath: failureEvidencePath } : {})
        });
        await persist(record);
        safeEmit({ type: "run_patch", runId, stepIndex: i, phase: "aborted", reasoning: fixerNote });
        safeEmit({ type: "run_error", runId, stepIndex: i, error: safeMsg, failure, recoveryFailure });
        return finishTerminalRun();
      }
      if (patch.kind === "abort") {
        const failure = {
          class: "product",
          component: "app",
          code: "recovery-aborted",
          retryable: false
        };
        record.status = "failed";
        record.endedAt = nowIso();
        record.error = `fixer aborted: ${patch.reasoning ?? ""}`;
        record.failure = failure;
        record.steps.push({
          stepIndex: i,
          stepId: step.id,
          type: step.type,
          status: "failed",
          durationMs: Date.now() - stepStart,
          error: record.error,
          failure,
          ...(err.visionMeta ? { vision: err.visionMeta } : {}),
          ...(failureEvidencePath ? { evidencePath: failureEvidencePath } : {})
        });
        await persist(record);
        safeEmit({ type: "run_patch", runId, stepIndex: i, phase: "aborted", reasoning: patch.reasoning });
        safeEmit({ type: "run_error", runId, stepIndex: i, error: record.error, failure });
        return finishTerminalRun();
      }
      if (patch.kind === "pause_for_user") {
        pauses += 1;
        const r = await pauseAndAwait({
          status: "paused_for_user",
          pauseInfo: { kind: "pause_for_user", stepIndex: i, reasoning: patch.reasoning, userInstructions: patch.userInstructions },
          event: { type: "run_pause_for_user", runId, stepIndex: i, reasoning: patch.reasoning, userInstructions: patch.userInstructions }
        });
        if (!r.resumed) return record;
        continue;
      }
      const patched = applyPatch(steps, i, patch);
      steps.length = 0;
      steps.push(...patched);
      safeEmit({ type: "run_patch", runId, stepIndex: i, phase: "applied", patchKind: patch.kind, reasoning: patch.reasoning, newStepDescription: patch.newStep?.description });
      // Retry at the same index (the inserted/replaced step, or the next step
      // after a skip). No i increment.
    }
  }

  record.status = "completed";
  record.endedAt = nowIso();
  await persist(record);
  safeEmit({ type: "run_complete", runId, durationMs: Date.parse(record.endedAt) - Date.parse(record.startedAt) });
  return finishTerminalRun();
}

async function execApiCall(step, { fetchImpl, connectorAuthEnv, collect }) {
  const spec = step.apiRequest ?? step;
  const headers = { ...(spec.headers ?? {}) };
  if (spec.authConnectorKey) {
    const env = await connectorAuthEnv(spec.authConnectorKey);
    collect?.(env);
    // Prefer an OAuth access token; else a generic token secret in the scope.
    const tokenVar = Object.keys(env).find((k) => k.endsWith("_ACCESS_TOKEN")) || Object.keys(env).find((k) => /TOKEN|KEY/.test(k));
    if (tokenVar) headers.Authorization = headers.Authorization || `Bearer ${env[tokenVar]}`;
  }
  const method = (spec.method || "GET").toUpperCase();
  const body = spec.body !== undefined && method !== "GET" && method !== "HEAD"
    ? typeof spec.body === "string"
      ? spec.body
      : JSON.stringify(spec.body)
    : undefined;
  if (body && !headers["content-type"] && (spec.bodyKind ?? "json") === "json") headers["content-type"] = "application/json";
  const res = await fetchImpl(interpolate(spec.url, {}), { method, headers, body });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  return { status: res.status, ok: res.ok, body: parsed ?? text.slice(0, 100000), isJson: parsed !== undefined };
}

// Default connector.mjs path for a connector id (mirrors the installed layout).
function connectorScriptPath(connectorId) {
  const base = process.env.GARRISON_COMPOSITION_DIR || process.cwd();
  // installed connectors live at apm_modules/_local/<id>/scripts/connector.mjs
  const id = connectorId === "google" ? "google" : connectorId === "slack" ? "slack-channel" : connectorId === "deepgram" ? "deepgram-voice" : connectorId;
  return `${base}/apm_modules/_local/${id}/scripts/connector.mjs`;
}

// Run the SAME automation once per viewport (delta 6) and group the results.
// Each viewport gets its own runId/run record (so existing per-run tooling —
// SSE, evidence, the results view — needs no special-casing); this just fans
// runAutomation out and writes one small grouped summary alongside them.
export async function runAutomationMatrix(opts) {
  const {
    automation,
    viewports,
    inputs = {},
    triggeredBy = "user",
    contextTag = null,
    bypassCache = false,
    ephemeral = false,
    matrixId = ulid(),
    emit = () => {},
    deps = {},
    persistMatrix = deps.persistMatrix || saveMatrixRun
  } = opts;
  if (!Array.isArray(viewports) || viewports.length === 0) {
    throw new Error("runAutomationMatrix requires a non-empty viewports array");
  }
  const startedAt = nowIso();
  const results = [];
  for (const viewport of viewports) {
    const runId = deps.runIdFor ? deps.runIdFor(viewport) : ulid();
    const record = await runAutomation({
      automation,
      inputs,
      triggeredBy,
      runId,
      contextTag,
      bypassCache,
      ephemeral,
      viewport,
      emit: (ev) => emit({ ...ev, matrixId, viewportId: viewport.id }),
      deps
    });
    results.push({ viewportId: viewport.id, viewport, runId, status: record.status });
  }
  const matrixRecord = {
    matrixId,
    automationId: automation.id,
    contextTag,
    startedAt,
    endedAt: nowIso(),
    viewports,
    results
  };
  await persistMatrix(matrixRecord);
  return matrixRecord;
}

export { getAutomation };

// flow-apply.mjs — the apply path for `orchestrator/flow` proposals.
//
// Every other Improver proposal applies by APPENDING MARKDOWN: apply-core takes
// the "+" lines out of the diff and adds a marked block to a notes file. That is
// the right contract for a convention or a learned hint, and it is the wrong one
// for a flow definition — a note saying "pin review to level 3" changes nothing
// the router reads. The `applyVia: "PUT /routing"` label on those proposals has
// been decorative for exactly that reason.
//
// The real programmatic edit path is the shell's PUT /api/orchestrator/policy:
// whole-document, baselineSha-guarded (409 on a stale baseline), validate- and
// compile-first (422 when the resulting config would not compile). This module
// speaks it.
//
// Three rules it holds to:
//   • NEVER a hardcoded port. The shell's address is the runner-projected
//     GARRISON_APP_URL / GARRISON_BASE_URL. Absent means "re-up the composition",
//     not "guess 7777" — a baked literal here would edit the WRONG INSTANCE's
//     routing config, and every baked literal in this repo has historically named
//     a different instance than the one running.
//   • The edit is applied to the config the shell just handed us, never to a
//     cached one, and re-applied from scratch after a 409 refetch. What the guard
//     protects against is precisely a concurrent edit, so replaying a stale
//     document over it would defeat the guard we just obeyed.
//   • A 422 is a HARD REJECT with the validator's own reason. The signal behind
//     the proposal may be real, but this edit is not valid, and retrying an
//     invalid document is how a loop starts.

/** The Garrison shell's base URL, as projected by the runner into this Fitting's
 *  env. Empty string when the composition has not projected one. */
export function shellBaseUrl(env = process.env) {
  const raw = env.GARRISON_APP_URL || env.GARRISON_BASE_URL || "";
  return String(raw).trim().replace(/\/+$/, "");
}

/**
 * Apply one pin edit to a routing config. PURE — returns a new document, so a
 * 409 retry can re-apply it to freshly-fetched config without carrying anything
 * over from the failed attempt.
 *
 * Returns null when the flow or the level the pin names is not in the config:
 * the flow library changed under the proposal, and inventing the missing
 * structure would author a flow level nobody asked for.
 */
export function applyPinToConfig(config, pinEdit) {
  if (!config || typeof config !== "object" || !pinEdit) return null;
  const { flow, flowLevel, duty, level } = pinEdit;
  if (!flow || !duty || !Number.isFinite(Number(level))) return null;
  const next = structuredClone(config);
  const flowDef = next.flows?.[flow];
  if (!flowDef || typeof flowDef !== "object") return null;
  const levelDef = flowDef.levels?.[String(flowLevel)];
  if (!levelDef || typeof levelDef !== "object") return null;
  levelDef.pins = { ...(levelDef.pins ?? {}), [duty]: Number(level) };
  return next;
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchPolicy({ base, compositionId, fetchImpl, timeoutMs }) {
  const q = compositionId ? `?composition=${encodeURIComponent(compositionId)}` : "";
  const res = await fetchImpl(`${base}/api/orchestrator/policy${q}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await readJson(res);
  if (!res.ok) return { ok: false, status: res.status, body };
  if (!body || typeof body.config !== "object" || body.config === null) {
    return { ok: false, status: res.status, body, malformed: true };
  }
  return { ok: true, config: body.config, baselineSha: body.baselineSha ?? null, composition: body.composition ?? compositionId };
}

async function putPolicy({ base, compositionId, config, baseline, fetchImpl, timeoutMs }) {
  const res = await fetchImpl(`${base}/api/orchestrator/policy`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...(compositionId ? { composition: compositionId } : {}), baseline, config }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, body: await readJson(res) };
}

/**
 * Apply an `orchestrator/flow` proposal through the shell.
 *
 * Outcomes, all explicit so the caller never has to infer one:
 *   { ok:true, evidence, recoveredFromConflict? }
 *   { ok:false, code:"no-app-url" | "not-appliable" | "no-pin-edit" | "flow-missing"
 *              | "read-failed" | "conflict" | "invalid" | "write-failed" | "unreachable" }
 * `invalid` carries the validator's `errors` and is terminal — the caller marks
 * the proposal rejected with that reason rather than retrying.
 */
export async function applyFlowProposal({
  proposal,
  compositionId,
  base = shellBaseUrl(),
  fetchImpl = fetch,
  timeoutMs = 15_000,
} = {}) {
  if (proposal?.appliable === false) {
    return { ok: false, code: "not-appliable", reason: "this proposal is manual-only by design" };
  }
  const pinEdit = proposal?.pinEdit;
  if (!pinEdit) return { ok: false, code: "no-pin-edit", reason: "proposal carries no machine-readable edit" };
  if (!base) {
    return {
      ok: false,
      code: "no-app-url",
      reason: "no GARRISON_APP_URL in this fitting's env - re-up the composition so the runner projects it",
    };
  }

  const attempt = async (baselineOverride) => {
    const read = await fetchPolicy({ base, compositionId, fetchImpl, timeoutMs });
    if (!read.ok) {
      return { done: true, result: { ok: false, code: "read-failed", status: read.status, body: read.body } };
    }
    const next = applyPinToConfig(read.config, pinEdit);
    if (!next) {
      return {
        done: true,
        result: {
          ok: false,
          code: "flow-missing",
          reason: `flows["${pinEdit.flow}"].levels["${pinEdit.flowLevel}"] is not in the live routing config`,
        },
      };
    }
    const wrote = await putPolicy({
      base,
      compositionId: read.composition ?? compositionId,
      config: next,
      baseline: baselineOverride ?? read.baselineSha,
      fetchImpl,
      timeoutMs,
    });
    return { done: false, read, next, wrote };
  };

  try {
    let a = await attempt();
    if (a.done) return a.result;
    if (a.wrote.status === 409) {
      // Someone edited routing.json between our read and our write. Re-read and
      // re-apply the pin onto the NEW document — never replay the stale one.
      a = await attempt();
      if (a.done) return a.result;
      if (a.wrote.status === 409) {
        return { ok: false, code: "conflict", reason: "routing.json changed twice during apply", body: a.wrote.body };
      }
      a.recovered = true;
    }
    if (a.wrote.status === 422) {
      const errors = Array.isArray(a.wrote.body?.errors) ? a.wrote.body.errors : [];
      return {
        ok: false,
        code: "invalid",
        terminal: true,
        reason: `the shell refused the edit as invalid: ${errors.join("; ") || "no detail given"}`,
        errors,
      };
    }
    if (a.wrote.status !== 200 || a.wrote.body?.ok !== true) {
      return { ok: false, code: "write-failed", status: a.wrote.status, body: a.wrote.body };
    }
    const serialized = JSON.stringify(a.next);
    return {
      ok: true,
      ...(a.recovered ? { recoveredFromConflict: true } : {}),
      evidence: {
        targetFile: `${a.read.composition ?? compositionId ?? "(active composition)"}/.garrison/routing.json`,
        bytes: serialized.length,
        sha: String(a.wrote.body?.baselineSha ?? ""),
        pin: pinEdit,
        ...(Array.isArray(a.wrote.body?.warnings) && a.wrote.body.warnings.length
          ? { warnings: a.wrote.body.warnings }
          : {}),
      },
    };
  } catch (err) {
    return { ok: false, code: "unreachable", reason: String(err?.message || err).slice(0, 300) };
  }
}

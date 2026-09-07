// Hand-rolled validator for the flow manifest and the findings collection.
//
// No ajv: this repo carries no JSON-schema runtime, and drill validates by hand
// for the same reason. The schema file next door is the human-readable contract;
// this is the executable one. They must be kept in step — the test suite asserts
// the enums here match the enums there.
//
// Pure. Returns { ok, errors } and never throws: callers want to report every
// problem in a manifest at once, not the first one.

export const SCHEMA_VERSION = 1;

export const SOURCES = ["ui", "e2e", "drillbook", "commit"];
export const STEP_KINDS = ["code", "db", "filewrite", "dep", "glue"];
export const STALENESS = ["fresh", "stale", "invalidated"];
export const SEVERITIES = ["info", "low", "medium", "high"];
export const FINDING_STATUSES = ["open", "accepted", "dismissed", "fixed"];
export const DETAIL_LEVELS = ["overview", "standard", "deep"];
export const EVIDENCE = ["static", "runtime", "both"];

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function validateFlow(obj) {
  const errors = [];
  const at = (p, msg) => errors.push(`${p}: ${msg}`);

  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, errors: ["root: expected an object"] };
  }
  if (obj.schemaVersion !== SCHEMA_VERSION) {
    // Refuse rather than guess: a manifest from a future shape must not be
    // half-rendered.
    at("schemaVersion", `expected ${SCHEMA_VERSION}, got ${JSON.stringify(obj.schemaVersion)}`);
  }
  if (!SLUG.test(String(obj.flowId ?? ""))) at("flowId", "expected a lowercase slug");
  if (!nonEmptyProse(obj.title)) at("title", "required (a string, or a {en, pt} map)");
  if (!validProse(obj.summary)) at("summary", "expected a string or a {en, pt} map");
  if (!SOURCES.includes(obj.source)) at("source", `expected one of ${SOURCES.join(", ")}`);
  if (obj.detailLevel !== undefined && !DETAIL_LEVELS.includes(obj.detailLevel)) {
    at("detailLevel", `expected one of ${DETAIL_LEVELS.join(", ")}`);
  }

  const anchor = obj.anchoredAt;
  if (!anchor || typeof anchor !== "object") at("anchoredAt", "required");
  else if (!SHA40.test(String(anchor.sha ?? ""))) at("anchoredAt.sha", "expected a 40-char sha");

  if (!Array.isArray(obj.states) || obj.states.length === 0) {
    at("states", "expected a non-empty array");
  } else {
    const stateIds = new Set();
    const stepIds = new Set();
    obj.states.forEach((state, si) => {
      const sp = `states[${si}]`;
      if (!state || typeof state !== "object") return at(sp, "expected an object");
      if (!SLUG.test(String(state.id ?? ""))) at(`${sp}.id`, "expected a lowercase slug");
      if (stateIds.has(state.id)) at(`${sp}.id`, `duplicate state id "${state.id}"`);
      stateIds.add(state.id);
      if (!nonEmptyProse(state.label)) at(`${sp}.label`, "required (a string, or a {en, pt} map)");
      if (!validProse(state.description)) at(`${sp}.description`, "expected a string or a {en, pt} map");
      // The logic view's functional narration. Optional by design: a flow analysed
      // before this field existed must stay valid, and the logic view says
      // "not yet narrated" rather than the validator saying "broken".
      if (!validProse(state.logic)) at(`${sp}.logic`, "expected a string or a {en, pt} map");
      if (!Array.isArray(state.steps) || state.steps.length === 0) {
        return at(`${sp}.steps`, "expected a non-empty array");
      }
      state.steps.forEach((step, ti) => {
        validateStep(step, `${sp}.steps[${ti}]`, at, stepIds);
      });
    });
    // Connector targets must resolve, or the viewer offers a dead end — the one
    // thing the brief's collapse-never-omit rule exists to prevent.
    obj.states.forEach((state, si) => {
      (state?.steps ?? []).forEach((step, ti) => {
        for (const link of step?.next ?? []) {
          const to = String(link?.to ?? "");
          if (to.startsWith("state:")) {
            if (!stateIds.has(to.slice(6))) {
              at(`states[${si}].steps[${ti}].next`, `unknown state "${to.slice(6)}"`);
            }
          } else if (!stepIds.has(to)) {
            at(`states[${si}].steps[${ti}].next`, `unknown step "${to}"`);
          }
        }
      });
    });
  }

  return { ok: errors.length === 0, errors };
}

function validateStep(step, p, at, stepIds) {
  if (!step || typeof step !== "object") return at(p, "expected an object");
  if (!SLUG.test(String(step.id ?? ""))) at(`${p}.id`, "expected a lowercase slug");
  if (stepIds.has(step.id)) at(`${p}.id`, `duplicate step id "${step.id}"`);
  stepIds.add(step.id);
  if (!nonEmptyProse(step.title)) at(`${p}.title`, "required (a string, or a {en, pt} map)");
  if (!validProse(step.description)) at(`${p}.description`, "expected a string or a {en, pt} map");
  if (!STEP_KINDS.includes(step.kind)) at(`${p}.kind`, `expected one of ${STEP_KINDS.join(", ")}`);

  if (step.sample && step.diffSample) {
    at(p, "a step carries either sample or diffSample, never both");
  }
  if (step.sample) validateSample(step.sample, `${p}.sample`, at);
  if (step.diffSample) validateDiffSample(step.diffSample, `${p}.diffSample`, at);

  // The external-system kinds have no file to extract from, so they must carry
  // their illustration explicitly rather than rendering an empty pane.
  if ((step.kind === "db" || step.kind === "filewrite") && !nonEmptyProse(step.asciiSample)) {
    at(`${p}.asciiSample`, `required for kind "${step.kind}"`);
  }
  if (step.kind === "dep" && !nonEmptyProse(step.note) && !nonEmptyProse(step.description)) {
    at(`${p}.note`, 'required for kind "dep" when there is no description');
  }
  if (step.kind === "code" && !step.sample && !step.diffSample) {
    at(`${p}.sample`, 'required for kind "code"');
  }

  if (step.next !== undefined) {
    if (!Array.isArray(step.next)) at(`${p}.next`, "expected an array");
    else
      step.next.forEach((link, i) => {
        if (!link || typeof link !== "object") at(`${p}.next[${i}]`, "expected an object");
        else if (!nonEmpty(link.to)) at(`${p}.next[${i}].to`, "required");
      });
  }

  if (step.staleness !== undefined) {
    const s = step.staleness;
    if (!s || typeof s !== "object") at(`${p}.staleness`, "expected an object");
    else {
      if (!STALENESS.includes(s.status)) {
        at(`${p}.staleness.status`, `expected one of ${STALENESS.join(", ")}`);
      }
      if (s.checkedAtSha !== undefined && !SHA40.test(String(s.checkedAtSha))) {
        at(`${p}.staleness.checkedAtSha`, "expected a 40-char sha");
      }
    }
  }
}

function validateSample(s, p, at) {
  if (!s || typeof s !== "object") return at(p, "expected an object");
  if (!nonEmpty(s.file)) at(`${p}.file`, "required");
  if (String(s.file ?? "").includes("\\")) {
    at(`${p}.file`, "must use forward slashes (repo-relative, platform-neutral)");
  }
  if (!Number.isInteger(s.startLine) || s.startLine < 1) at(`${p}.startLine`, "expected a 1-indexed integer");
  if (!Number.isInteger(s.endLine) || s.endLine < 1) at(`${p}.endLine`, "expected a 1-indexed integer");
  if (Number.isInteger(s.startLine) && Number.isInteger(s.endLine) && s.endLine < s.startLine) {
    at(`${p}.endLine`, "endLine is before startLine");
  }
  if (!SHA256.test(String(s.extractedSha256 ?? ""))) {
    at(`${p}.extractedSha256`, "expected a 64-char sha256 — samples must be extracted, never typed");
  }
  if (s.sha !== undefined && !SHA40.test(String(s.sha))) at(`${p}.sha`, "expected a 40-char sha");
  if (s.highlights !== undefined) {
    if (!Array.isArray(s.highlights)) at(`${p}.highlights`, "expected an array");
    else
      s.highlights.forEach((pair, i) => {
        if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(Number.isInteger)) {
          at(`${p}.highlights[${i}]`, "expected [startLine, endLine] integers");
          return;
        }
        if (pair[0] < s.startLine || pair[1] > s.endLine) {
          at(
            `${p}.highlights[${i}]`,
            `[${pair[0]}, ${pair[1]}] falls outside the sample window ${s.startLine}-${s.endLine}`
          );
        }
      });
  }
}

function validateDiffSample(s, p, at) {
  if (!s || typeof s !== "object") return at(p, "expected an object");
  if (!nonEmpty(s.file)) at(`${p}.file`, "required");
  if (!SHA40.test(String(s.sha ?? ""))) at(`${p}.sha`, "expected a 40-char sha");
  if (typeof s.patch !== "string" || s.patch.length === 0) at(`${p}.patch`, "required");
  if (!SHA256.test(String(s.extractedSha256 ?? ""))) {
    at(`${p}.extractedSha256`, "expected a 64-char sha256 over the patch text");
  }
}

export function validateFindings(obj) {
  const errors = [];
  const at = (p, msg) => errors.push(`${p}: ${msg}`);
  if (!obj || typeof obj !== "object") return { ok: false, errors: ["root: expected an object"] };
  if (obj.schemaVersion !== SCHEMA_VERSION) {
    at("schemaVersion", `expected ${SCHEMA_VERSION}`);
  }
  if (!Array.isArray(obj.findings)) return { ok: false, errors: ["findings: expected an array"] };

  const ids = new Set();
  obj.findings.forEach((f, i) => {
    const p = `findings[${i}]`;
    if (!f || typeof f !== "object") return at(p, "expected an object");
    if (!SLUG.test(String(f.id ?? ""))) at(`${p}.id`, "expected a lowercase slug");
    if (ids.has(f.id)) at(`${p}.id`, `duplicate finding id "${f.id}"`);
    ids.add(f.id);
    if (!nonEmpty(f.flowId)) at(`${p}.flowId`, "required");
    if (!SEVERITIES.includes(f.severity)) at(`${p}.severity`, `expected one of ${SEVERITIES.join(", ")}`);
    if (!nonEmptyProse(f.text)) at(`${p}.text`, "required (a string, or a {en, pt} map)");
    if (!validProse(f.suggestion)) at(`${p}.suggestion`, "expected a string or a {en, pt} map");
    if (f.status !== undefined && !FINDING_STATUSES.includes(f.status)) {
      at(`${p}.status`, `expected one of ${FINDING_STATUSES.join(", ")}`);
    }
    if (f.evidence !== undefined && !EVIDENCE.includes(f.evidence)) {
      at(`${p}.evidence`, `expected one of ${EVIDENCE.join(", ")}`);
    }
    if (f.span !== undefined) {
      if (!f.span || typeof f.span !== "object") at(`${p}.span`, "expected an object");
      else if (!nonEmpty(f.span.file)) at(`${p}.span.file`, "required");
    }
  });

  return { ok: errors.length === 0, errors };
}

export function validateViewerIndex(obj) {
  const errors = [];
  if (!obj || typeof obj !== "object") return { ok: false, errors: ["root: expected an object"] };
  if (obj.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion: expected ${SCHEMA_VERSION}`);
  if (!Array.isArray(obj.flowOrder)) errors.push("flowOrder: expected an array");
  return { ok: errors.length === 0, errors };
}

/** Stable slug from arbitrary text, for ids derived from test titles or paths. */
/**
 * A prose field may be a plain string (the norm — one language, chosen at intake)
 * or a per-language map like {en: "...", pt: "..."} for a project that opted into
 * bilingual narration. Both are valid; the renderer resolves it with pickText.
 *
 * Bilingual prose is opt-in rather than default because it doubles the narration
 * work, which is the one genuinely expensive part of the whole product.
 */
function nonEmptyProse(v) {
  if (typeof v === "string") return v.trim().length > 0;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return LANG_KEYS.some((k) => typeof v[k] === "string" && v[k].trim().length > 0);
  }
  return false;
}

const LANG_KEYS = ["en", "pt"];

/** True when a prose field is absent, a string, or a well-formed language map. */
function validProse(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === "string") return true;
  if (typeof v !== "object" || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  if (keys.length === 0) return false;
  return keys.every((k) => LANG_KEYS.includes(k) && typeof v[k] === "string");
}

export function safeId(text, fallback = "flow") {
  const slug = String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return SLUG.test(slug) ? slug : fallback;
}

function nonEmpty(v) {
  return typeof v === "string" && v.trim().length > 0;
}

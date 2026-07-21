// Automation schema for the Automations engine. Automations are YAML files at
// ~/.garrison/automations/<id>.yml. This module is the single source of truth
// for the step-type vocabulary + a validator/normalizer the store and engine
// share. (ekoa's `integration` step is renamed `connector`; `ekoa_action` is
// dropped — 8 step types, not 9.)

export const STEP_TYPES = [
  "browser", // vision-resolved Playwright action (cache -> vision -> execute)
  "verify", // vision assertion the page reached the expected state
  "navigate", // page.goto(url) — deterministic, no vision
  "wait", // delay (ms)
  "local_command", // a shell command on the user's machine (consent-gated)
  "api_call", // raw HTTP, optionally borrowing a connector's sealed auth
  "connector", // call a connected service's catalog action (was ekoa `integration`)
  "sub_automation" // run another saved automation as one step
];

export const TRIGGER_TYPES = ["manual", "cron", "webhook", "listener"];

export function isStepType(t) {
  return STEP_TYPES.includes(t);
}

// Validate an automation object; throws Error on the first problem. Kept strict
// enough to catch authoring mistakes (unknown step type, missing ids) without
// over-specifying type-discriminated fields (the engine tolerates absent
// optionals).
export function validateAutomation(auto) {
  if (!auto || typeof auto !== "object") throw new Error("automation must be an object");
  if (!auto.id || typeof auto.id !== "string") throw new Error("automation.id (string) is required");
  if (!auto.name || typeof auto.name !== "string") throw new Error("automation.name (string) is required");
  if (auto.trigger && !TRIGGER_TYPES.includes(auto.trigger.type)) {
    throw new Error(`unknown trigger type: ${auto.trigger.type}`);
  }
  if (!Array.isArray(auto.steps)) throw new Error("automation.steps must be an array");
  const seenIds = new Set();
  auto.steps.forEach((step, i) => {
    if (!step || typeof step !== "object") throw new Error(`step ${i} must be an object`);
    if (!isStepType(step.type)) throw new Error(`step ${i}: unknown type "${step.type}"`);
    // Step ids must be unique strings — the action cache is keyed by step id, so
    // a duplicate id would let one step replay another's cached action.
    if (step.id !== undefined) {
      if (typeof step.id !== "string" || !step.id) throw new Error(`step ${i}: id must be a non-empty string`);
      if (seenIds.has(step.id)) throw new Error(`step ${i}: duplicate step id "${step.id}"`);
      seenIds.add(step.id);
    }
    if (step.type === "sub_automation" && !step.sub_automation_id) {
      throw new Error(`step ${i} (sub_automation) requires sub_automation_id`);
    }
  });
  return true;
}

// Fill defaults so a partial authored automation is well-formed for storage.
export function normalizeAutomation(auto, { now } = {}) {
  const ts = now ?? new Date().toISOString();
  return {
    id: auto.id,
    name: auto.name,
    description: auto.description ?? "",
    trigger: auto.trigger ?? { type: "manual" },
    inputs: Array.isArray(auto.inputs) ? auto.inputs : [],
    // enabled/tags (engine delta 4): a disabled step is compiled but skipped at
    // run time (tier "skipped"), never removed — so re-enabling needs no re-plan.
    steps: Array.isArray(auto.steps)
      ? auto.steps.map((s, i) => ({
          id: s.id ?? `step-${i + 1}`,
          ...s,
          enabled: s.enabled !== false,
          tags: Array.isArray(s.tags) ? s.tags : []
        }))
      : [],
    createdAt: auto.createdAt ?? ts,
    updatedAt: ts
  };
}

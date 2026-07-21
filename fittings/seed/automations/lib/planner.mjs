// Automation planner. Turns a Discuss-authored brief (plain markdown) into a
// reviewable Automation (steps), routing the model call through the Model Router
// (decision 5 — no hardcoded model). The planner is a Router target: the default
// `invoke` POSTs to the backend /api/automations/plan, which resolveRoute()s the
// "automation" classification and invokes the chosen model via the gateway. The
// planning LOGIC (prompt + parse + validate) lives here so it is unit-testable
// with an injected invoke.

import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { STEP_TYPES, validateAutomation, normalizeAutomation } from "./types.mjs";
import { ulid } from "./ulid.mjs";

export const PLANNER_SKILL_ID = "discuss-automation";

function internalToken() {
  try {
    const home = process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
    const file = process.env.GARRISON_INTERNAL_TOKEN_PATH || path.join(home, "internal-token");
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

// Build the planning prompt: the brief + the available connector actions + the
// exact step-type vocabulary + the required JSON output shape.
export function buildPlannerPrompt({ brief, catalog = [], automationName }) {
  const catalogLines = catalog.length
    ? catalog
        .map((c) => `- ${c.service} (${c.auth ?? "?"}): ${(c.actions ?? []).map((a) => a.name + (a.mutates ? "*" : "")).join(", ")}`)
        .join("\n")
    : "(no connectors connected — use api_call / local_command / browser steps)";
  return [
    "You are the Garrison automation planner. Turn the brief below into a runnable automation.",
    "",
    `Step types you may use (ONLY these): ${STEP_TYPES.join(", ")}.`,
    "  - browser: a vision-resolved action (description). verify: assert a page state. navigate: {url}.",
    "  - wait: {durationMs}. local_command: {command}. api_call: {apiRequest:{method,url,headers,body,authConnectorKey}}.",
    "  - connector: {connector, action, args} — call a connected service's catalog action.",
    "  - sub_automation: {sub_automation_id, args}.",
    "",
    "Connected services + their actions (a '*' marks a mutating action):",
    catalogLines,
    "",
    "Use {{input.NAME}} for inputs, {{capture.STEP_ID.field}} for prior step results.",
    "",
    "BRIEF:",
    brief,
    "",
    `Output ONLY a JSON object (optionally fenced) with this shape:`,
    `{ "name": ${JSON.stringify(automationName || "Automation")}, "description": "...", "inputs": [{"name":"...","required":true}], "steps": [{"id":"step-1","type":"<one of the step types>","description":"...", ...type-specific fields}] }`,
    "No prose outside the JSON."
  ].join("\n");
}

// Parse the model's reply into a steps object. Accepts a fenced ```json block or
// a bare JSON object.
export function parsePlan(text) {
  if (!text || typeof text !== "string") throw new Error("planner returned no text");
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  let parsed;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    throw new Error("planner reply was not valid JSON");
  }
  if (!parsed || !Array.isArray(parsed.steps)) throw new Error("planner reply missing steps[]");
  return parsed;
}

// Default invoke: route the planning prompt through the backend Model Router.
async function defaultInvoke(prompt, { fetchImpl = globalThis.fetch } = {}) {
  const base = process.env.GARRISON_BASE_URL || "http://127.0.0.1:27777";
  const res = await fetchImpl(`${base}/api/automations/plan`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-garrison-internal": internalToken() },
    body: JSON.stringify({ prompt })
  });
  if (!res.ok) throw new Error(`planner route ${res.status}`);
  const json = await res.json();
  return json.text ?? "";
}

// Plan an automation from a brief. `invoke(prompt) -> modelText` is injectable;
// the default routes through the Model Router. Returns a validated, normalized
// Automation (NOT yet saved — the caller reviews/saves it).
export async function planFromBrief({ brief, catalog = [], automationName, id, invoke, now }) {
  const run = invoke || ((p) => defaultInvoke(p));
  const prompt = buildPlannerPrompt({ brief, catalog, automationName });
  const text = await run(prompt);
  const plan = parsePlan(text);
  const automation = normalizeAutomation(
    {
      id: id || ulid(),
      name: plan.name || automationName || "Automation",
      description: plan.description ?? "",
      inputs: plan.inputs ?? [],
      trigger: plan.trigger ?? { type: "manual" },
      steps: plan.steps
    },
    { now }
  );
  validateAutomation(automation);
  return automation;
}

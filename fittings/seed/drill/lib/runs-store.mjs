// Drill's OWN run records — machine-local (NOT the target app repo; R6/A8:
// "Runs persist under ~/.garrison/automations/runs... The Book links to them;
// it does not duplicate them" — so a Drill run record stores only a
// REFERENCE to each page/viewport's automations runId, plus the Drill-level
// metadata automations doesn't know about: per-step feedback, verdict
// overrides, run-level observations, and the findings report/triage. Atomic
// writes (temp + rename), same convention as lib/store.mjs.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ulid } from "./ulid.mjs";

export function drillHomeDir() {
  return process.env.GARRISON_DRILL_HOME || path.join(process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison"), "drill");
}

function runsDir() {
  return path.join(drillHomeDir(), "runs");
}

function safeId(id) {
  const safe = String(id).replace(/[^A-Za-z0-9_-]/g, "");
  if (!safe || safe !== String(id)) throw new Error(`invalid run id: ${id}`);
  return safe;
}

function runPath(id) {
  return path.join(runsDir(), `${safeId(id)}.json`);
}

async function atomicWriteJson(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
  await fs.rename(tmp, file);
}

export function newDrillRun({ contextTag = "drill", state = "default", dispatch = "manual", project = null } = {}) {
  return {
    id: ulid(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    contextTag,
    state,
    project, // target repo root at run creation - lets the UI scope results to the selected project
    dispatch, // "manual" | "heartbeat" | "immediate" — captured at run creation (D10) so a heartbeat sweep knows which runs opted in
    dispatchedAt: null,
    dispatchedCard: null,
    pages: [], // [{pageId, viewportId, automationRunId, status}]
    feedback: {}, // "<pageId>:<stepId>" -> [{id, note, at}]
    overrides: {}, // "<pageId>:<stepId>" -> {verdict, note, at}
    observations: [], // [{id, text, at, convertedToStep, convertedToFinding}]
    findings: [], // product findings only: [{id, kind, pageId, stepId, text, status, at}]
    // Dependency/runtime failures are evidence about the test harness, not
    // claims about the product under test. Keep them visible and traceable
    // without flooding the human triage queue.
    infraErrors: [] // grouped incidents: [{id, code, component, text, occurrences, at}]
  };
}

export async function saveDrillRun(record) {
  await atomicWriteJson(runPath(record.id), record);
  return record;
}

export async function getDrillRun(id) {
  try {
    return JSON.parse(await fs.readFile(runPath(safeId(id)), "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export async function deleteDrillRun(id) {
  try {
    await fs.unlink(runPath(safeId(id)));
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

// Harness failures - the vision route, gateway, browser or automations
// fittings being down - say NOTHING about the app under test. They must not
// pool as findings (a wall of "vision 503" findings buries the real report)
// and the results UI renders them separately. Patterns match the exact error
// strings each layer emits: the engine's visionResolve (`vision 503`), the
// vision route (`gateway unreachable`/`gateway 502`, `model router
// unavailable`, `vision reply had no JSON`), the fitting clients
// (`browser fitting not running`, `browser 502:`, `automations fitting not
// running`) and node's connection-level failures.
const INFRA_PATTERNS = [
  /\bvision \d{3}\b/i,
  /\bfixer \d{3}\b/i,
  /\bgateway (unreachable|\d{3})\b/i,
  /model router unavailable/i,
  /vision reply had no JSON/i,
  /gateway reply unparseable/i,
  /vision result parse failed/i,
  /browser fitting not running/i,
  /\bbrowser \d{3}:/i,
  /automations fitting not running/i,
  /\bautomations \d{3}\b/i,
  /ECONNREFUSED|fetch failed/i
];

export function isInfraError(text) {
  if (!text) return false;
  const s = String(text);
  return INFRA_PATTERNS.some((re) => re.test(s));
}

// Slim row for the runs table: dates + counts only, no automation-run
// resolution (listing must stay cheap over many runs).
export function runListingRow(record) {
  const findings = { proposed: 0, confirmed: 0, dismissed: 0 };
  for (const f of record.findings ?? []) {
    if (findings[f.status] !== undefined) findings[f.status] += 1;
  }
  return {
    id: record.id,
    startedAt: record.startedAt,
    endedAt: record.endedAt ?? null,
    contextTag: record.contextTag,
    state: record.state,
    project: record.project ?? null,
    dispatchedAt: record.dispatchedAt ?? null,
    steps: (record.pages ?? []).length,
    summary: record.summary ?? null,
    findings
  };
}

export async function listDrillRuns() {
  let entries;
  try {
    entries = await fs.readdir(runsDir());
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const file of entries.filter((f) => f.endsWith(".json"))) {
    try {
      out.push(JSON.parse(await fs.readFile(path.join(runsDir(), file), "utf8")));
    } catch { /* skip unparseable */ }
  }
  return out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

export const stepKey = (pageId, stepId, viewportId = null) =>
  viewportId ? `${pageId}:${stepId}:${viewportId}` : `${pageId}:${stepId}`;

export function addFeedback(record, pageId, stepId, note, viewportId = null) {
  const key = stepKey(pageId, stepId, viewportId);
  const list = record.feedback[key] ?? [];
  list.push({ id: ulid(), note, viewportId, at: new Date().toISOString() });
  record.feedback[key] = list;
  return record;
}

// D5/D8: a verdict override in either direction, with a note.
export function setOverride(record, pageId, stepId, verdict, note, viewportId = null) {
  record.overrides[stepKey(pageId, stepId, viewportId)] = {
    verdict,
    note: note ?? "",
    viewportId,
    at: new Date().toISOString()
  };
  return record;
}

// D9: a run-level observation. Recording it never requires a re-run.
export function addObservation(record, text) {
  const obs = { id: ulid(), text, at: new Date().toISOString(), convertedToStep: null, convertedToFinding: null };
  record.observations.push(obs);
  return obs;
}

// D10: pool a finding (failure / flipped verdict / observation / UX note)
// into the report as "proposed" — triage (confirm/dismiss) happens after.
// `evidence` (Drill Evidence v0.1) is an optional pointer into the run's
// evidence dir: { screenshot, trace, videoMs } — relative names only.
export function addFinding(record, { kind, pageId, stepId = null, viewportId = null, text, evidence = null }) {
  const finding = {
    id: ulid(), kind, pageId, stepId, viewportId, text, status: "proposed", at: new Date().toISOString(),
    ...(evidence ? { evidence } : {})
  };
  record.findings.push(finding);
  return finding;
}

export function addInfraError(record, {
  pageId,
  stepId = null,
  viewportId = null,
  text,
  code = "dependency-error",
  component = "drill"
}) {
  record.infraErrors ??= [];
  const normalizedText = String(text ?? "Infrastructure failure").trim();
  const existing = record.infraErrors.find(
    (item) => item.code === code && item.component === component && item.text === normalizedText
  );
  const occurrence = { pageId, stepId, viewportId };
  if (existing) {
    existing.occurrences ??= [];
    existing.occurrences.push(occurrence);
    existing.count = existing.occurrences.length;
    return existing;
  }
  const error = {
    id: ulid(),
    code,
    component,
    pageId,
    stepId,
    text: normalizedText,
    count: 1,
    occurrences: [occurrence],
    at: new Date().toISOString()
  };
  record.infraErrors.push(error);
  return error;
}

export function legacyInfrastructureInfo(finding) {
  if (!finding) return null;
  const text = String(finding.text ?? "").trim();
  if (finding.kind === "infra-error") {
    return { component: "drill", code: "legacy-infra", text };
  }
  if (finding.kind !== "step-fail") return null;
  let match;
  if (/^automations unavailable(?:\b|:)/i.test(text) || /^automations fitting not running\b/i.test(text)) {
    return { component: "automations", code: "automations-unavailable", text };
  }
  if ((match = text.match(/^vision (?:HTTP )?([45]\d\d)(?::.*)?$/i))) {
    return { component: "vision", code: `vision-http-${match[1]}`, text };
  }
  if ((match = text.match(/^fixer (?:HTTP )?([45]\d\d)(?::.*)?$/i))) {
    return { component: "fixer", code: `fixer-http-${match[1]}`, text };
  }
  if ((match = text.match(/^fixer failed: fixer (?:HTTP )?([45]\d\d)(?::.*)?$/i))) {
    return { component: "fixer", code: `fixer-http-${match[1]}`, text };
  }
  if (/^(?:TypeError:\s*)?fetch failed(?:$|:)/i.test(text)) {
    return { component: "automations", code: "transport-fetch-failed", text };
  }
  if (/^(?:browser|vision|fixer|gateway|orchestrator) fitting not running(?:\b|:)/i.test(text)) {
    const component = text.split(/\s+/)[0].toLowerCase();
    return { component, code: `${component}-unavailable`, text };
  }
  return null;
}

export function isInfrastructureFinding(finding) {
  return legacyInfrastructureInfo(finding) !== null;
}

export function productFindings(record) {
  return (record.findings ?? []).filter((finding) => !isInfrastructureFinding(finding));
}

export function normalizedInfraErrors(record) {
  const grouped = new Map();
  const add = (item) => {
    const text = String(item.text ?? "Infrastructure failure").trim();
    const component = item.component ?? "drill";
    const code = item.code ?? "dependency-error";
    const key = `${component}\u0000${code}\u0000${text}`;
    const occurrences = Array.isArray(item.occurrences) && item.occurrences.length > 0
      ? item.occurrences
      : [{ pageId: item.pageId ?? null, stepId: item.stepId ?? null, viewportId: item.viewportId ?? null }];
    const count = Math.max(Number(item.count) || 0, occurrences.length, 1);
    const existing = grouped.get(key);
    if (existing) {
      existing.occurrences.push(...occurrences);
      existing.count += count;
      return;
    }
    grouped.set(key, {
      ...item,
      text,
      component,
      code,
      count,
      occurrences: [...occurrences]
    });
  };
  for (const item of record.infraErrors ?? []) add(item);
  for (const finding of record.findings ?? []) {
    const info = legacyInfrastructureInfo(finding);
    if (!info) continue;
    add({
      id: finding.id,
      ...info,
      pageId: finding.pageId ?? null,
      stepId: finding.stepId ?? null,
      viewportId: finding.viewportId ?? null,
      at: finding.at,
      count: 1
    });
  }
  return [...grouped.values()];
}

export function publicRunRecord(record) {
  return {
    ...record,
    findings: productFindings(record),
    infraErrors: normalizedInfraErrors(record)
  };
}

export function setFindingStatus(record, findingId, status) {
  const f = record.findings.find((x) => x.id === findingId);
  if (!f) throw new Error(`finding not found: ${findingId}`);
  if (isInfrastructureFinding(f)) throw new Error("infrastructure incidents cannot be triaged as product findings");
  if (!["proposed", "confirmed", "dismissed"].includes(status)) throw new Error(`invalid finding status: ${status}`);
  f.status = status;
  return f;
}

export function confirmedProductFindings(record) {
  return productFindings(record).filter((finding) => {
    if (finding.status !== "confirmed") return false;
    if (!finding.stepId) return true;
    const matchingEntries = (record.pages ?? []).filter((entry) =>
      entry.pageId === finding.pageId &&
      entry.stepId === finding.stepId &&
      (!finding.viewportId || entry.viewportId === finding.viewportId)
    );
    if (matchingEntries.length === 0) return true;
    return matchingEntries.some((entry) => {
      const general = record.overrides?.[stepKey(entry.pageId, entry.stepId)];
      const scoped = record.overrides?.[stepKey(entry.pageId, entry.stepId, entry.viewportId)];
      return (scoped ?? general)?.verdict !== "passed";
    });
  });
}

export function confirmedFindings(record) {
  return confirmedProductFindings(record);
}

// A finding already sent to a fix card carries `card` {id, url, at}. Dispatch
// only ever sends confirmed findings NOT yet on a card - double-clicking the
// button, or re-dispatching after some findings were already fixed, must not
// mint duplicate cards carrying the same work (observed live 2026-07-17: two
// identical batch cards 8s apart).
export function undispatchedConfirmedFindings(record) {
  return confirmedProductFindings(record).filter((finding) => !finding.card);
}

export function markFindingsDispatched(record, findingIds, card) {
  const at = new Date().toISOString();
  for (const id of findingIds) {
    const f = record.findings.find((x) => x.id === id);
    if (f) f.card = { id: card.id, url: card.url ?? null, at };
  }
  return record;
}

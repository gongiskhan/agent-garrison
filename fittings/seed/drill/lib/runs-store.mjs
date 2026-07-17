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
    pages: [], // [{pageId, viewportId, automationRunId, status}]
    feedback: {}, // "<pageId>:<stepId>" -> [{id, note, at}]
    overrides: {}, // "<pageId>:<stepId>" -> {verdict, note, at}
    observations: [], // [{id, text, at, convertedToStep, convertedToFinding}]
    findings: [] // [{id, kind, pageId, stepId, text, status, at}]
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

const stepKey = (pageId, stepId) => `${pageId}:${stepId}`;

export function addFeedback(record, pageId, stepId, note) {
  const key = stepKey(pageId, stepId);
  const list = record.feedback[key] ?? [];
  list.push({ id: ulid(), note, at: new Date().toISOString() });
  record.feedback[key] = list;
  return record;
}

// D5/D8: a verdict override in either direction, with a note.
export function setOverride(record, pageId, stepId, verdict, note) {
  record.overrides[stepKey(pageId, stepId)] = { verdict, note: note ?? "", at: new Date().toISOString() };
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
export function addFinding(record, { kind, pageId, stepId = null, text }) {
  const finding = { id: ulid(), kind, pageId, stepId, text, status: "proposed", at: new Date().toISOString() };
  record.findings.push(finding);
  return finding;
}

export function setFindingStatus(record, findingId, status) {
  const f = record.findings.find((x) => x.id === findingId);
  if (!f) throw new Error(`finding not found: ${findingId}`);
  if (!["proposed", "confirmed", "dismissed"].includes(status)) throw new Error(`invalid finding status: ${status}`);
  f.status = status;
  return f;
}

export function confirmedFindings(record) {
  return record.findings.filter((f) => f.status === "confirmed");
}

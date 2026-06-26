// YAML automation store. Automations are machine-local YAML files at
// ~/.garrison/automations/<id>.yml (decision F3/F4). Override the root with
// GARRISON_AUTOMATIONS_DIR (used by tests). Briefs live under <root>/briefs/,
// run records under <root>/runs/ (the engine writes those).

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { validateAutomation, normalizeAutomation } from "./types.mjs";
import { ulid } from "./ulid.mjs";

export function automationsDir() {
  return process.env.GARRISON_AUTOMATIONS_DIR ?? path.join(os.homedir(), ".garrison", "automations");
}

function automationPath(id) {
  // id is used as a filename — confine it to a single slug-ish segment so a
  // crafted id can't traverse out of the automations dir.
  const safe = String(id).replace(/[^A-Za-z0-9_-]/g, "");
  if (!safe || safe !== String(id)) throw new Error(`invalid automation id: ${id}`);
  return path.join(automationsDir(), `${safe}.yml`);
}

export async function listAutomations() {
  const dir = automationsDir();
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const file of entries.filter((f) => f.endsWith(".yml"))) {
    try {
      const raw = await fs.readFile(path.join(dir, file), "utf8");
      const parsed = yaml.load(raw);
      if (parsed && typeof parsed === "object") out.push(parsed);
    } catch {
      // skip an unparseable file rather than failing the whole list
    }
  }
  return out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

export async function getAutomation(id) {
  try {
    const raw = await fs.readFile(automationPath(id), "utf8");
    return yaml.load(raw) ?? null;
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export async function saveAutomation(auto, { now } = {}) {
  const withId = auto.id ? auto : { ...auto, id: ulid(now ? Date.parse(now) : undefined) };
  const normalized = normalizeAutomation(withId, { now });
  validateAutomation(normalized);
  const dir = automationsDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(automationPath(normalized.id), yaml.dump(normalized), "utf8");
  return normalized;
}

export async function deleteAutomation(id) {
  try {
    await fs.unlink(automationPath(id));
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

function runsDir() {
  return path.join(automationsDir(), "runs");
}

function runPath(runId) {
  const safe = String(runId).replace(/[^A-Za-z0-9_-]/g, "");
  if (!safe || safe !== String(runId)) throw new Error(`invalid run id: ${runId}`);
  return path.join(runsDir(), `${safe}.json`);
}

export async function saveRun(record) {
  await fs.mkdir(runsDir(), { recursive: true });
  await fs.writeFile(runPath(record.id), JSON.stringify(record, null, 2), "utf8");
  return record;
}

export async function getRun(runId) {
  try {
    return JSON.parse(await fs.readFile(runPath(runId), "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export async function listRuns(automationId) {
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
      const rec = JSON.parse(await fs.readFile(path.join(runsDir(), file), "utf8"));
      if (!automationId || rec.automationId === automationId) out.push(rec);
    } catch {
      // skip unparseable
    }
  }
  return out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

export async function saveBrief(slug, markdown) {
  const safe = String(slug).replace(/[^A-Za-z0-9_-]/g, "");
  if (!safe) throw new Error(`invalid brief slug: ${slug}`);
  const dir = path.join(automationsDir(), "briefs");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${safe}.md`);
  await fs.writeFile(file, markdown, "utf8");
  return file;
}

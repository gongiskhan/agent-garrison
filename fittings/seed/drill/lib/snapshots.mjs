// Snapshots (C3/C4): observe() parts + a screenshot, kept as plain
// machine-local files with links (R13 — no artifact store). Promoting one to
// a named state writes the state's matcher/reachPath into the page's repo
// YAML (via store.mjs's savePage); the screenshot file itself stays
// machine-local, re-capturable via the reach path (Q8).

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ulid } from "./ulid.mjs";
import { drillTargetRoot } from "./store.mjs";

export function drillHomeDir() {
  return process.env.GARRISON_DRILL_HOME || path.join(process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison"), "drill");
}

function safeId(id) {
  const safe = String(id).replace(/[^A-Za-z0-9_-]/g, "");
  if (!safe || safe !== String(id)) throw new Error(`invalid id: ${id}`);
  return safe;
}

// Machine-local but PROJECT-scoped: pages carry short conventional ids
// (home, chat, ...) that collide across projects, and a promoted snapshot
// writes its fingerprint into the ACTIVE project's page YAML - one project's
// snapshots must never surface under another's page of the same name.
function projectKey() {
  return crypto.createHash("sha256").update(drillTargetRoot()).digest("hex").slice(0, 12);
}

function snapshotsDir(pageId) {
  return path.join(drillHomeDir(), "snapshots", projectKey(), safeId(pageId));
}

async function atomicWrite(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, file);
}

// parts: { url, title, headingText, shapeSketch, viewport, screenshotB64 }
export async function saveSnapshot(pageId, parts) {
  const id = ulid();
  const dir = snapshotsDir(pageId);
  const meta = {
    id,
    pageId,
    project: drillTargetRoot(),
    at: new Date().toISOString(),
    url: parts.url,
    title: parts.title,
    headingText: parts.headingText,
    shapeSketch: parts.shapeSketch,
    viewport: parts.viewport,
    screenshotPath: parts.screenshotB64 ? path.join(dir, `${id}.jpg`) : null
  };
  if (parts.screenshotB64) {
    await atomicWrite(meta.screenshotPath, Buffer.from(parts.screenshotB64, "base64"));
  }
  await atomicWrite(path.join(dir, `${id}.json`), JSON.stringify(meta, null, 2));
  return meta;
}

export async function listSnapshots(pageId) {
  let entries;
  try {
    entries = await fs.readdir(snapshotsDir(pageId));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const f of entries.filter((f) => f.endsWith(".json"))) {
    try {
      out.push(JSON.parse(await fs.readFile(path.join(snapshotsDir(pageId), f), "utf8")));
    } catch { /* skip unparseable */ }
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

export async function getSnapshot(pageId, snapshotId) {
  try {
    return JSON.parse(await fs.readFile(path.join(snapshotsDir(pageId), `${safeId(snapshotId)}.json`), "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

// Sidebar organizer state - the user's arrangement of the session list.
//
// Groups, membership, manual order, read marks and archived rows are UI
// organization, not conversation data: they live in ONE json beside the thread
// store, whole-document read/replace (single user, tiny payload), atomic
// write. Thread rows themselves stay in threads.mjs; a row key here is
// `local:<threadId>` for this node's threads and `<node>:<threadId>` for
// rows mirrored from the mesh, so the arrangement survives either side
// changing independently. Stale keys (deleted threads) are ignored by the
// renderer and swept opportunistically on save.

import path from "node:path";
import os from "node:os";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

function garrisonDir() {
  const env = process.env.GARRISON_HOME?.trim();
  return env || path.join(os.homedir(), ".garrison");
}

function sidebarPath() {
  return path.join(garrisonDir(), "web-channel", "sidebar.json");
}

const LIMITS = {
  groups: 50,
  groupName: 40,
  key: 200,
  keysPerList: 500,
  readEntries: 2000
};

const KEY_RE = /^[a-z0-9][a-z0-9._-]*:[A-Za-z0-9._-]{1,120}$/i;

function cleanKey(raw) {
  return typeof raw === "string" && raw.length <= LIMITS.key && KEY_RE.test(raw) ? raw : null;
}

function cleanKeyList(raw, cap = LIMITS.keysPerList) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const k of raw) {
    const key = cleanKey(k);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= cap) break;
  }
  return out;
}

export function sanitizeSidebar(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const groups = [];
  const groupIds = new Set();
  if (Array.isArray(src.groups)) {
    for (const g of src.groups) {
      if (!g || typeof g !== "object") continue;
      const id = typeof g.id === "string" && /^g-[A-Za-z0-9-]{1,40}$/.test(g.id) ? g.id : null;
      const name = typeof g.name === "string" ? g.name.trim().slice(0, LIMITS.groupName) : "";
      if (!id || !name || groupIds.has(id)) continue;
      groupIds.add(id);
      groups.push({ id, name, collapsed: Boolean(g.collapsed) });
      if (groups.length >= LIMITS.groups) break;
    }
  }
  const membership = {};
  if (src.membership && typeof src.membership === "object") {
    for (const [k, v] of Object.entries(src.membership)) {
      const key = cleanKey(k);
      if (!key || typeof v !== "string" || !groupIds.has(v)) continue;
      membership[key] = v;
      if (Object.keys(membership).length >= LIMITS.readEntries) break;
    }
  }
  const order = {};
  if (src.order && typeof src.order === "object") {
    for (const [gid, list] of Object.entries(src.order)) {
      if (gid !== "_ungrouped" && gid !== "_archived" && !groupIds.has(gid)) continue;
      order[gid] = cleanKeyList(list);
    }
  }
  const read = {};
  if (src.read && typeof src.read === "object") {
    for (const [k, v] of Object.entries(src.read)) {
      const key = cleanKey(k);
      if (!key || typeof v !== "string" || Number.isNaN(Date.parse(v))) continue;
      read[key] = v;
      if (Object.keys(read).length >= LIMITS.readEntries) break;
    }
  }
  const archived = cleanKeyList(src.archived);
  // The unread epoch: activity BEFORE this instant never reads as unread,
  // so a decade of history doesn't light up on the feature's first day.
  const baselineAt = typeof src.baselineAt === "string" && !Number.isNaN(Date.parse(src.baselineAt))
    ? src.baselineAt
    : null;
  return { groups, membership, order, read, archived, baselineAt };
}

export async function loadSidebar() {
  try {
    return sanitizeSidebar(JSON.parse(await readFile(sidebarPath(), "utf8")));
  } catch {
    return sanitizeSidebar(null);
  }
}

export async function saveSidebar(raw) {
  const clean = sanitizeSidebar(raw);
  const file = sidebarPath();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(clean, null, 2), "utf8");
  await rename(tmp, file);
  return clean;
}

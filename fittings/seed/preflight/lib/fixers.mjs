// Narrow repairs. Every request is serialized and matched against a fresh
// report before touching anything; command arguments never come from the UI.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, rename, unlink, mkdir, appendFile, open, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { findRepoRoot, GARRISON_HOME } from "./collect.mjs";
import { RETIRED_SEED_IDS } from "./preflight-core.mjs";
import { appUrl } from "./app-client.mjs";

const ID_RE = /^[A-Za-z0-9][\w.-]{0,199}$/;
const MAX_DIFF_BYTES = 200_000;
const hash = (text) => createHash("sha256").update(text).digest("hex");
const canonical = (value) => JSON.stringify(Object.fromEntries(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b))));
const ACTION_KEYS = {
  "tailscale-serve-map": ["port"],
  "unstation-fitting": ["compositionId", "fittingId"],
  "library-add-entry": ["fittingId"],
  "library-remove-entry": ["entryId"],
  "git-commit-library": ["diffHash"]
};

export function execOk(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20_000, maxBuffer: 512_000, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ""), err: String(stderr || err?.message || "") });
    });
  });
}

export async function libraryChange(root, exec = execOk) {
  const git = (args) => exec("git", ["-C", root, ...args]);
  const [head, diff, staged] = await Promise.all([
    git(["rev-parse", "HEAD"]),
    git(["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--", "data/library.json"]),
    git(["diff", "--no-ext-diff", "--no-textconv", "--cached", "--", "data/library.json"])
  ]);
  if (![head, diff, staged].every((r) => r.ok)) return { diff: null, diffHash: null };
  if (!diff.out.trim()) return { diff: null, diffHash: null };
  if (Buffer.byteLength(diff.out) > MAX_DIFF_BYTES) {
    return { diff: "The library diff is too large to review here. Review and commit it with git.", diffHash: null };
  }
  return { diff: diff.out, diffHash: hash(`${head.out}\0${diff.out}\0${staged.out}`) };
}

async function fetchJson(url, { fetchImpl = fetch, ...opts } = {}) {
  const res = await fetchImpl(url, {
    ...opts,
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(15_000),
    redirect: "error"
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Garrison request failed (HTTP ${res.status})${data?.error ? `: ${String(data.error).slice(0, 300)}` : ""}`);
  return data;
}

async function exists(file) {
  try { await stat(file); return true; } catch (err) { if (err.code === "ENOENT") return false; throw err; }
}

async function readLibrary(root) {
  const file = path.join(root, "data", "library.json");
  const raw = await readFile(file, "utf8");
  const entries = JSON.parse(raw);
  if (!Array.isArray(entries)) throw new Error("library.json must contain an array");
  return { file, raw, entries };
}

async function saveLibrary(snapshot, entries) {
  // Avoid torn reads and refuse intervening writes rather than replacing them.
  const temporary = `${snapshot.file}.preflight-${randomUUID()}`;
  try {
    const mode = (await stat(snapshot.file)).mode & 0o777;
    await writeFile(temporary, JSON.stringify(entries, null, 2) + "\n", { flag: "wx", mode });
    if (await readFile(snapshot.file, "utf8") !== snapshot.raw) throw new Error("library.json changed during the repair; refresh and retry");
    await rename(temporary, snapshot.file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

function validParams(actionId, params) {
  if (!Object.hasOwn(ACTION_KEYS, actionId) || !params || typeof params !== "object" || Array.isArray(params)) return false;
  const keys = ACTION_KEYS[actionId];
  if (Object.keys(params).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(params, key))) return false;
  if (actionId === "tailscale-serve-map") return Number.isInteger(params.port) && params.port > 0 && params.port < 65536;
  if (actionId === "git-commit-library") return typeof params.diffHash === "string" && /^[a-f0-9]{64}$/.test(params.diffHash);
  return keys.every((key) => typeof params[key] === "string" && ID_RE.test(params[key]));
}

async function appendJournal(home, entry) {
  // Record only the validated action parameters and our bounded result.
  try {
    await mkdir(home, { recursive: true });
    await appendFile(path.join(home, "preflight-fixes.jsonl"), JSON.stringify(entry) + "\n", { mode: 0o600 });
  } catch { /* A failed audit append cannot undo an already completed repair. */ }
}

export async function readFixJournal(limit = 20, { home = GARRISON_HOME } = {}) {
  const count = Math.min(100, Math.max(0, Math.floor(limit)));
  if (!count) return [];
  let file;
  try {
    file = await open(path.join(home, "preflight-fixes.jsonl"), "r");
    const { size } = await file.stat();
    const start = Math.max(0, size - 256_000);
    const buffer = Buffer.alloc(size - start);
    await file.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start) lines.shift();
    return lines.filter(Boolean).slice(-count).reverse()
      .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch { return []; } finally { await file?.close(); }
}

export function createFixRunner({
  root: suppliedRoot,
  home = GARRISON_HOME,
  env = process.env,
  exec = execOk,
  fetchImpl = fetch,
  getReport = async () => (await import("./report.mjs")).buildReport({ startDir: suppliedRoot || process.cwd() })
} = {}) {
  let tail = Promise.resolve();
  const run = async (actionId, params) => {
    if (!validParams(actionId, params)) return { ok: false, error: "unknown action or invalid parameters" };
    let result;
    try {
      const root = suppliedRoot || findRepoRoot(process.cwd());
      if (!root) throw new Error("Garrison repo root not found");
      if (actionId !== "git-commit-library") {
        const report = await getReport();
        const current = report?.findings?.some((finding) => finding.action?.id === actionId && canonical(finding.action.params) === canonical(params));
        if (!current) throw new Error("This finding has changed or no longer needs repair; refresh the report");
      }
      switch (actionId) {
        case "tailscale-serve-map": {
          const profile = env.GARRISON_INSTANCE_ID || "node";
          if (!["node", "prod"].includes(profile)) throw new Error("Only the node profile may publish tailnet views");
          const identity = JSON.parse(await readFile(path.join(home, "node.json"), "utf8"));
          if (!identity?.name) throw new Error("Node identity is required before publishing views");
          if (identity.tethered) throw new Error("This tethered node's views must be published by its owner node");
          const publisher = path.join(root, "scripts", "tailnet-serve-views.mjs");
          const published = await exec(process.execPath, [publisher], { env, timeout: 60_000 });
          if (!published.ok) throw new Error(`View publication failed: ${published.err.slice(0, 400)}`);
          result = { ok: true, detail: "Published missing view mappings through the node publisher; refresh to check coverage" };
          break;
        }
        case "unstation-fitting": {
          const base = (env.GARRISON_APP_URL || env.GARRISON_BASE_URL || (env === process.env ? appUrl() : "")).replace(/\/+$/, "");
          if (!base || base.startsWith("(")) throw new Error("Garrison app URL is not configured");
          const endpoint = `${base}/api/compositions/${encodeURIComponent(params.compositionId)}`;
          const got = await fetchJson(endpoint, { fetchImpl });
          const selections = {};
          let removed = false;
          for (const [faculty, items] of Object.entries(got?.composition?.selections || {})) {
            if (!Array.isArray(items)) throw new Error("Garrison returned invalid selections");
            selections[faculty] = items.filter((item) => {
              if (item.id === params.fittingId) { removed = true; return false; }
              return true;
            });
          }
          if (!removed) throw new Error("The fitting is no longer selected; refresh the report");
          // The app owns unfitted, comment preservation and authority CAS. Never
          // read state credentials or implement a second authority write here.
          const saved = await fetchJson(endpoint, { method: "PUT", body: { selections }, fetchImpl });
          if (!saved?.composition || Object.values(saved.composition.selections || {}).flat().some((item) => item.id === params.fittingId)) {
            throw new Error("The composition did not confirm the fitting was unstationed; refresh before retrying");
          }
          result = { ok: true, detail: `${params.fittingId} unstationed from ${params.compositionId} through Garrison's manifest writer` };
          break;
        }
        case "library-add-entry": {
          if (RETIRED_SEED_IDS.has(params.fittingId)) throw new Error("This seed was deliberately retired and must not be registered");
          const snapshot = await readLibrary(root);
          if (snapshot.entries.some((entry) => entry.id === params.fittingId)) throw new Error("Entry already exists; refresh the report");
          const seedDir = path.join(root, "fittings", "seed", params.fittingId);
          const manifest = parseYaml(await readFile(path.join(seedDir, "apm.yml"), "utf8"));
          // Use the platform's current contract, including kinds/faculties/views,
          // rather than a second permissive schema in the doctor.
          const checked = await exec(process.execPath, ["--import", "tsx", path.join(root, "scripts", "validate-fitting.ts"), seedDir], { cwd: root, env });
          if (!checked.ok) throw new Error("Seed failed Garrison's fitting validation; repair its manifest before registering it");
          const summary = String(manifest.description || `${params.fittingId} fitting.`).trim().slice(0, 2000);
          const entries = [...snapshot.entries, {
            id: params.fittingId, name: params.fittingId,
            repo: `local:fittings/seed/${params.fittingId}`, localPath: `fittings/seed/${params.fittingId}`,
            summary, platforms: ["claude-code"]
          }];
          await saveLibrary(snapshot, entries);
          result = { ok: true, detail: `Added ${params.fittingId}; review the full library diff before committing` };
          break;
        }
        case "library-remove-entry": {
          const snapshot = await readLibrary(root);
          const entry = snapshot.entries.find((item) => item.id === params.entryId);
          const match = entry?.localPath?.match(/^fittings\/seed\/([A-Za-z0-9][\w.-]*)\/?$/);
          if (!entry || !match) throw new Error("Only a missing local seed entry can be removed");
          if (await exists(path.join(root, "fittings", "seed", match[1]))) throw new Error("The seed directory exists; refresh and inspect its manifest instead");
          await saveLibrary(snapshot, snapshot.entries.filter((item) => item.id !== params.entryId));
          result = { ok: true, detail: `Removed missing seed ${params.entryId}; review the full library diff before committing` };
          break;
        }
        case "git-commit-library": {
          await readLibrary(root); // A deleted or malformed registry is never committed here.
          const change = await libraryChange(root, exec);
          if (!change.diffHash || change.diffHash !== params.diffHash) throw new Error("The library diff or git state changed; refresh and review it again");
          // --only commits exactly the reviewed working-tree file. Other staged
          // paths remain staged; there is no separate git-add partial mutation.
          const committed = await exec("git", ["-C", root, "commit", "--only", "-m", "preflight: update reviewed fitting registry", "--", "data/library.json"]);
          if (!committed.ok) throw new Error(`Commit failed: ${committed.err.slice(0, 300)}`);
          result = { ok: true, detail: "Committed the reviewed library.json diff; no push was performed" };
          break;
        }
      }
    } catch (err) {
      result = { ok: false, error: String(err?.message || err).slice(0, 600) };
    }
    await appendJournal(home, { at: new Date().toISOString(), actionId, params, ...result });
    return result;
  };
  return (actionId, params = {}) => {
    const result = tail.then(() => run(actionId, params));
    tail = result.then(() => {}, () => {});
    return result;
  };
}

export const runFix = createFixRunner();

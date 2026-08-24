#!/usr/bin/env node
// The one-time importer: today's files → the state service DB. Run ONCE on
// dev-madrid. Seed-or-migrate-never-clobber: INSERT OR IGNORE semantics
// throughout (existing rows win), --force for a deliberate re-import.
//
//   node scripts/import-from-files.mjs --dry-run     counts + every skip, no writes
//   node scripts/import-from-files.mjs               import
//   node scripts/import-from-files.mjs --verify      re-read files, diff, exit 1 on any difference
//   node scripts/import-from-files.mjs --finalize    rename consumed sources to *.pre-mesh (rollback = rename back)
//
// Env: GARRISON_HOME (default ~/.garrison), GARRISON_REPO (default the
// checkout this script sits in), GARRISON_STATE_DB.

import { readFileSync, readdirSync, existsSync, statSync, renameSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.mjs";
import { getMasterKey, seal, sha256Hex } from "../src/crypto.mjs";
import { compositionPathAllowed } from "../src/lib/transferable-path.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.GARRISON_REPO?.trim() || path.resolve(HERE, "..", "..", "..");
const HOME = process.env.GARRISON_HOME?.trim() || path.join(os.homedir(), ".garrison");
const SELF_NODE = process.env.GARRISON_NODE_NAME?.trim() || "dev-madrid";

const DRY = process.argv.includes("--dry-run");
const VERIFY = process.argv.includes("--verify");
const FINALIZE = process.argv.includes("--finalize");
const FORCE = process.argv.includes("--force");

const now = () => new Date().toISOString();
const report = { imported: {}, skipped: [], verified: {}, mismatches: [] };

function bump(kind, n = 1) {
  report.imported[kind] = (report.imported[kind] ?? 0) + n;
}
function skip(kind, what, why) {
  report.skipped.push({ kind, what, why });
}

function readJson(p, fallback) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

const db = openDb();

// INSERT only when absent (or --force replaces). Every import writes
// updated_by='import' so provenance is queryable forever.
function has(table, where, args) {
  return !!db.prepare(`SELECT 1 FROM ${table} WHERE ${where}`).get(...args);
}

// ── 1. nodes ← outpost-registry.json ────────────────────────────────────────
function importNodes() {
  const regPath = path.join(HOME, "outpost-registry.json");
  const reg = readJson(regPath, null);
  const entries = Array.isArray(reg?.outposts) ? reg.outposts : [];
  // dev-madrid itself: registered by issue-node-token, not the registry.
  for (const entry of entries) {
    const name = String(entry.name ?? "").trim();
    if (!name || name === "host") {
      skip("node", name || "(empty)", "reserved or empty name — never imported");
      continue;
    }
    if (has("nodes", "name=?", [name]) && !FORCE) {
      skip("node", name, "already registered");
      continue;
    }
    if (DRY) { bump("nodes"); continue; }
    // Tokens are HASHED on import — the registry's cleartext token keeps
    // working from the Macs, but the DB never stores it raw.
    db.prepare(
      `INSERT INTO nodes(name, token_hash, token_prefix, accent_color, platform, registered_at, status)
       VALUES (?,?,?,?,?,?, 'active')
       ON CONFLICT(name) DO UPDATE SET token_hash=excluded.token_hash, token_prefix=excluded.token_prefix`
    ).run(name, sha256Hex(String(entry.token ?? "")), String(entry.token ?? "").slice(0, 8), "#6b7f6e", "darwin", entry.registeredAt ?? now());
    bump("nodes");
  }
  return regPath;
}

// ── 2. secrets ← data vault.json (decrypt once, re-seal row-wise) ───────────
function importSecrets() {
  const vaultPath = process.env.GARRISON_VAULT_PATH?.trim() || path.join(HOME, "vault.json");
  if (!existsSync(vaultPath)) {
    skip("secrets", vaultPath, "no vault file");
    return vaultPath;
  }
  const file = readJson(vaultPath, null);
  if (!file || file.kdf !== "hkdf-sha256" || file.version !== 1) {
    skip("secrets", vaultPath, `unsupported vault format kdf=${file?.kdf}`);
    return vaultPath;
  }
  const masterKey = getMasterKey();
  const fileKey = Buffer.from(
    crypto.hkdfSync("sha256", masterKey, Buffer.from(file.salt, "base64"), Buffer.from("garrison-vault-v2"), 32)
  );
  const decipher = crypto.createDecipheriv("aes-256-gcm", fileKey, Buffer.from(file.iv, "base64"));
  decipher.setAuthTag(Buffer.from(file.tag, "base64"));
  const plaintext = JSON.parse(
    Buffer.concat([decipher.update(Buffer.from(file.ciphertext, "base64")), decipher.final()]).toString("utf8")
  );
  const secrets = plaintext?.secrets ?? {};
  for (const [key, value] of Object.entries(secrets)) {
    if (has("secrets", "key=?", [key]) && !FORCE) {
      skip("secret", key, "already present");
      continue;
    }
    if (DRY) { bump("secrets"); continue; }
    db.prepare(
      `INSERT INTO secrets(key, ciphertext, updated_at, updated_by, rev) VALUES (?,?,?,?,1)
       ON CONFLICT(key) DO UPDATE SET ciphertext=excluded.ciphertext, updated_at=excluded.updated_at`
    ).run(key, seal(String(value)), now(), "import");
    bump("secrets");
  }
  // Grant policy: all keys to the authority node, nothing elsewhere — the
  // first peer grant must be a DELIBERATE ACT.
  if (!DRY) {
    db.prepare("INSERT OR IGNORE INTO secret_grants(node, pattern) VALUES (?, '*')").run(SELF_NODE);
  }
  report.verified.secretsCount = Object.keys(secrets).length;
  return vaultPath;
}

// ── 3. loadouts ─────────────────────────────────────────────────────────────
function importLoadouts() {
  const dir = path.join(HOME, "loadouts");
  if (!existsSync(dir)) return dir;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const id = f.replace(/\.json$/, "");
    const ns = `loadout.${id}`;
    if (has("config_docs", "namespace=? AND scope='global'", [ns]) && !FORCE) {
      skip("loadout", id, "already present");
      continue;
    }
    const body = readJson(path.join(dir, f), null);
    if (!body) { skip("loadout", id, "unparseable"); continue; }
    if (DRY) { bump("loadouts"); continue; }
    const bodyJson = JSON.stringify(body);
    db.prepare(
      `INSERT INTO config_docs(namespace, scope, body_json, body_sha, rev, updated_at, updated_by)
       VALUES (?,?,?,?,1,?, 'import')
       ON CONFLICT(namespace, scope) DO UPDATE SET body_json=excluded.body_json, body_sha=excluded.body_sha, rev=config_docs.rev+1`
    ).run(ns, "global", bodyJson, sha256Hex(bodyJson), now());
    bump("loadouts");
  }
  return dir;
}

// ── 4. compositions ─────────────────────────────────────────────────────────
function walkAllowed(compDir, sub = "") {
  const out = [];
  const abs = path.join(compDir, sub);
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = sub ? `${sub}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if ([".garrison", ".garrison/prompts"].includes(rel)) out.push(...walkAllowed(compDir, rel));
      continue;
    }
    if (compositionPathAllowed(rel)) out.push(rel);
  }
  return out;
}

function importCompositions() {
  const dir = path.join(REPO, "compositions");
  if (!existsSync(dir)) return dir;
  for (const id of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
    const compDir = path.join(dir, id);
    const manifestPath = path.join(compDir, "apm.yml");
    if (!existsSync(manifestPath)) { skip("composition", id, "no apm.yml"); continue; }
    const manifest = readFileSync(manifestPath, "utf8");
    if (has("compositions", "id=?", [id]) && !FORCE) {
      skip("composition", id, "already present");
    } else if (!DRY) {
      db.prepare(
        `INSERT INTO compositions(id, manifest_yaml, manifest_sha, rev, updated_at, updated_by) VALUES (?,?,?,1,?, 'import')
         ON CONFLICT(id) DO UPDATE SET manifest_yaml=excluded.manifest_yaml, manifest_sha=excluded.manifest_sha, rev=compositions.rev+1`
      ).run(id, manifest, sha256Hex(manifest), now());
      bump("compositions");
    } else {
      bump("compositions");
    }
    for (const rel of walkAllowed(compDir)) {
      if (has("composition_files", "composition_id=? AND path=?", [id, rel]) && !FORCE) continue;
      const body = readFileSync(path.join(compDir, rel), "utf8");
      if (Buffer.byteLength(body) > 512 * 1024) { skip("composition-file", `${id}/${rel}`, ">512KB"); continue; }
      if (DRY) { bump("composition-files"); continue; }
      db.prepare(
        `INSERT INTO composition_files(composition_id, path, body, rev, updated_at, updated_by) VALUES (?,?,?,1,?, 'import')
         ON CONFLICT(composition_id, path) DO UPDATE SET body=excluded.body, rev=composition_files.rev+1`
      ).run(id, rel, body, now());
      bump("composition-files");
    }
  }
  return dir;
}

// ── 5+6. board + cards ──────────────────────────────────────────────────────
function importBoard() {
  const kanbanDir = process.env.GARRISON_KANBAN_DIR?.trim() || path.join(HOME, "kanban-loop");
  const boardPath = path.join(kanbanDir, "board.json");
  const board = readJson(boardPath, null);
  if (board) {
    if (!has("config_docs", "namespace='board.layout' AND scope='global'", []) || FORCE) {
      if (!DRY) {
        const bodyJson = JSON.stringify(board);
        db.prepare(
          `INSERT INTO config_docs(namespace, scope, body_json, body_sha, rev, updated_at, updated_by)
           VALUES ('board.layout','global',?,?,1,?, 'import')
           ON CONFLICT(namespace, scope) DO UPDATE SET body_json=excluded.body_json, body_sha=excluded.body_sha, rev=config_docs.rev+1`
        ).run(bodyJson, sha256Hex(bodyJson), now());
      }
      bump("board-layout");
    } else {
      skip("board", "board.json", "already present");
    }
  }

  const cardsDir = path.join(kanbanDir, "cards");
  if (!existsSync(cardsDir)) return kanbanDir;
  let position = 0;
  for (const id of readdirSync(cardsDir)) {
    const cardPath = path.join(cardsDir, id, "card.json");
    if (!existsSync(cardPath)) continue;
    const card = readJson(cardPath, null);
    if (!card) { skip("card", id, "unparseable card.json"); continue; }
    if (has("cards", "id=?", [id]) && !FORCE) { skip("card", id, "already present"); continue; }

    // "host" meant "where Garrison runs" — that referent is retired.
    if (card.placement?.target === "host") card.placement.target = SELF_NODE;
    // Fail-closed holds: an unparseable timestamp is dropped WITH A REPORT,
    // never silently and never imported broken.
    for (const field of ["scheduledFor"]) {
      if (card[field] && !Number.isFinite(Date.parse(card[field]))) {
        skip("card-field", `${id}.${field}`, `unparseable ${JSON.stringify(card[field])} — cleared, card holds nowhere`);
        delete card[field];
      }
    }
    if (card.placement?.not_before && !Number.isFinite(Date.parse(card.placement.not_before))) {
      skip("card-field", `${id}.placement.not_before`, "unparseable — cleared");
      delete card.placement.not_before;
    }
    if (DRY) { bump("cards"); continue; }
    position += 10;
    db.prepare(
      `INSERT INTO cards(id, list, position, status, title, project, scope, rev, coordination_seq,
        placement_target, placement_not_before, scheduled_for, schedule_json, occurrence_key, system_key,
        origin_id, created_at, updated_at, updated_by, body_json)
       VALUES (@id,@list,@position,@status,@title,@project,@scope,@rev,@cseq,@pt,@pnb,@sf,@sj,@ok,@sk,@oid,@cat,@uat,'import',@body)`
    ).run({
      id,
      list: String(card.list ?? "inbox"),
      position: Number(card.position) || position,
      status: String(card.status ?? ""),
      title: String(card.title ?? ""),
      project: card.routing?.project ?? card.project ?? null,
      scope: String(card.scope ?? "default"),
      rev: Number(card.rev) || 0,
      cseq: Number(card.coordinationSeq) || 0,
      pt: card.placement?.target ?? null,
      pnb: card.placement?.not_before ?? null,
      sf: card.scheduledFor ?? null,
      sj: card.schedule ? JSON.stringify(card.schedule) : null,
      ok: card.occurrenceKey ?? null,
      sk: card.systemKey ?? null,
      oid: card.origin_id ?? null,
      cat: card.created_at ?? now(),
      uat: card.updated_at ?? now(),
      body: JSON.stringify(card)
    });
    bump("cards");

    // Side docs: brief, handoff, LATEST log final text. Attachments as rows.
    const cardDir = path.join(cardsDir, id);
    for (const doc of ["brief.md", "handoff.json"]) {
      const p = path.join(cardDir, doc);
      if (existsSync(p)) {
        db.prepare(
          `INSERT OR IGNORE INTO card_docs(card_id, name, body, rev, updated_at, updated_by) VALUES (?,?,?,1,?, 'import')`
        ).run(id, doc, readFileSync(p, "utf8"), now());
        bump("card-docs");
      }
    }
    const logs = readdirSync(cardDir).filter((f) => /^log-\d+\.md$/.test(f)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
    if (logs.length) {
      const latest = logs[logs.length - 1];
      db.prepare(
        `INSERT OR IGNORE INTO card_docs(card_id, name, body, rev, updated_at, updated_by) VALUES (?,?,?,1,?, 'import')`
      ).run(id, latest, readFileSync(path.join(cardDir, latest), "utf8"), now());
      bump("card-docs");
    }
    const attachDir = path.join(cardDir, "attachments");
    if (existsSync(attachDir)) {
      for (const name of readdirSync(attachDir)) {
        const st = statSync(path.join(attachDir, name));
        if (!st.isFile()) continue;
        db.prepare(
          `INSERT OR IGNORE INTO card_attachments(card_id, name, bytes, sha256, home_node, created_at) VALUES (?,?,?,NULL,?,?)`
        ).run(id, name, st.size, SELF_NODE, now());
        bump("card-attachments");
      }
    }
  }
  return kanbanDir;
}

// ── 7. origins + events (ORDER PRESERVED) ───────────────────────────────────
function importOrigins() {
  const dir = path.join(process.env.GARRISON_KANBAN_DIR?.trim() || path.join(HOME, "kanban-loop"), "origins");
  if (!existsSync(dir)) return dir;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".events.json"))) {
    const origin = readJson(path.join(dir, f), null);
    if (!origin) { skip("origin", f, "unparseable"); continue; }
    const originId = origin.origin_id ?? origin.id ?? f.replace(/\.json$/, "");
    if (!has("origins", "origin_id=?", [originId]) || FORCE) {
      if (!DRY) {
        db.prepare(
          `INSERT INTO origins(origin_id, transport, address, home_node, body_json, created_at) VALUES (?,?,?,?,?,?)
           ON CONFLICT(origin_id) DO NOTHING`
        ).run(originId, String(origin.transport ?? "unknown"), origin.address ?? null, SELF_NODE, JSON.stringify(origin), origin.created_at ?? now());
      }
      bump("origins");
    }
    const eventsPath = path.join(dir, f.replace(/\.json$/, ".events.jsonl"));
    if (existsSync(eventsPath)) {
      const lines = readFileSync(eventsPath, "utf8").split("\n").filter((l) => l.trim());
      for (const line of lines) {
        let ev;
        try { ev = JSON.parse(line); } catch { skip("origin-event", originId, "unparseable line"); continue; }
        if (DRY) { bump("origin-events"); continue; }
        db.prepare(
          `INSERT INTO events(at, kind, subject_type, subject_id, origin_id, node, payload_json) VALUES (?,?,?,?,?,?,?)`
        ).run(ev.at ?? ev.ts ?? now(), String(ev.kind ?? ev.type ?? "origin.event"), "origin", originId, originId, "import", JSON.stringify(ev));
        bump("origin-events");
      }
    }
  }
  return dir;
}

// ── 8. scheduler jobs (structured where recognised, else pinned shell) ──────
// The recognisable pattern: [ENV=x ...] node <abs>/apm_modules/_local/<fitting>/scripts/<script>.mjs [args]
const FITTING_CMD_RE = /(?:^|\s)node\s+\S*apm_modules\/_local\/([a-z0-9-]+)\/(scripts\/[a-z0-9./-]+\.mjs)((?:\s+\S+)*)\s*$/;
const KNOWN_ENV_FROM = {
  GARRISON_GATEWAY_URL: "gateway_url",
  GARRISON_HOME: "garrison_home",
  GARRISON_KANBAN_DIR: "kanban_dir",
  GARRISON_APP_URL: "app_url",
  GARRISON_OUTPOST_URL: "outpost_url",
  GARRISON_COMPOSITION_DIR: "composition_dir",
  GARRISON_COMPOSITION_ID: "composition_id"
};

export function parseJobCommand(command) {
  const m = String(command ?? "").match(FITTING_CMD_RE);
  if (!m) return null;
  const [, fitting, script, argsRaw] = m;
  const envFrom = [];
  for (const [envName, resolved] of Object.entries(KNOWN_ENV_FROM)) {
    if (command.includes(`${envName}=`)) envFrom.push(resolved);
  }
  // Any OTHER VAR= assignment we cannot resolve per-node → not shareable.
  const assignments = [...command.matchAll(/(?:^|\s)([A-Z][A-Z0-9_]*)=/g)].map((x) => x[1]);
  const unknown = assignments.filter((a) => !(a in KNOWN_ENV_FROM));
  if (unknown.length) return null;
  return {
    kind: "fitting-script",
    fitting,
    script,
    args: argsRaw.trim() ? argsRaw.trim().split(/\s+/) : [],
    env_from: envFrom
  };
}

function importSchedulerJobs() {
  const jobsPath = process.env.GARRISON_SCHEDULER_JOBS?.trim() || path.join(HOME, "scheduler-jobs.json");
  const jobs = readJson(jobsPath, []);
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!job?.id || !job?.cron) { skip("job", job?.id ?? "(no id)", "missing id or cron"); continue; }
    if (has("scheduler_jobs", "id=?", [job.id]) && !FORCE) { skip("job", job.id, "already present"); continue; }
    const structured = parseJobCommand(job.command);
    // NEVER SILENTLY SHARED: an unrecognised command is by definition
    // machine-specific and lands pinned to this node as a shell job.
    const spec = structured ?? { kind: "shell", command: String(job.command ?? ""), cwd: job.cwd ?? null };
    const target = `node:${SELF_NODE}`;
    if (!structured) skip("job-shape", job.id, "unrecognised command — imported as node-pinned shell");
    if (DRY) { bump("scheduler-jobs"); continue; }
    db.prepare(
      `INSERT INTO scheduler_jobs(id, cron, type, enabled, target, spec_json, description, registered_by, rev, updated_at, updated_by)
       VALUES (?,?,?,?,?,?,?, 'import', 1, ?, 'import')
       ON CONFLICT(id) DO NOTHING`
    ).run(job.id, job.cron, job.type ?? "cron", job.enabled === false ? 0 : 1, target, JSON.stringify(spec), job.description ?? null, now());
    bump("scheduler-jobs");
  }
  return jobsPath;
}

// ── 9. feedback queue (LINE ORDER PRESERVED, legacy key byte-identical) ─────
function derivedKeyForLine(rawLine) {
  return `raw:${crypto.createHash("sha256").update(String(rawLine ?? "").trim()).digest("hex").slice(0, 32)}`;
}

function importFeedback() {
  const p = path.join(HOME, "improver", "feedback-queue.jsonl");
  if (!existsSync(p)) return p;
  const lines = readFileSync(p, "utf8").split("\n").filter((l) => l.trim());
  for (const raw of lines) {
    let record;
    try { record = JSON.parse(raw); } catch { skip("feedback", raw.slice(0, 40), "unparseable line"); continue; }
    if (record?.kind === "tombstone") {
      if (DRY) { bump("feedback-tombstones"); continue; }
      db.prepare("INSERT INTO feedback_tombstones(target, at, node, reason) VALUES (?,?,?,?)").run(
        String(record.target ?? ""), record.at ?? now(), "import", record.reason ?? null
      );
      bump("feedback-tombstones");
      continue;
    }
    const id = typeof record?.id === "string" && record.id.trim() ? record.id.trim() : null;
    const legacyKey = id ? null : derivedKeyForLine(raw);
    const key = id ?? legacyKey;
    if (has("feedback_queue", "id=?", [key]) && !FORCE) { skip("feedback", key, "already present"); continue; }
    if (DRY) { bump("feedback"); continue; }
    db.prepare(
      `INSERT OR IGNORE INTO feedback_queue(id, at, node, kind, area, session_id, payload_json, legacy_key)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(key, record.at ?? record.ts ?? now(), "import", record.kind ?? null, record.area ?? null, record.sessionId ?? record.session_id ?? null, JSON.stringify(record), legacyKey);
    bump("feedback");
  }
  return p;
}

// ── 10. accounts metadata + paymaster ───────────────────────────────────────
function importAccounts() {
  const accountsPath = path.join(HOME, "accounts.json");
  const accounts = readJson(accountsPath, null);
  if (accounts && (!has("config_docs", "namespace='accounts.registry' AND scope='global'", []) || FORCE)) {
    if (!DRY) {
      const bodyJson = JSON.stringify(accounts);
      db.prepare(
        `INSERT INTO config_docs(namespace, scope, body_json, body_sha, rev, updated_at, updated_by)
         VALUES ('accounts.registry','global',?,?,1,?, 'import')
         ON CONFLICT(namespace, scope) DO UPDATE SET body_json=excluded.body_json, body_sha=excluded.body_sha, rev=config_docs.rev+1`
      ).run(bodyJson, sha256Hex(bodyJson), now());
    }
    bump("accounts-registry");
  }
  const usagePath = path.join(HOME, "paymaster-usage.json");
  const usage = readJson(usagePath, null);
  const entries = Array.isArray(usage) ? usage : Array.isArray(usage?.entries) ? usage.entries : [];
  for (const e of entries) {
    if (DRY) { bump("paymaster"); continue; }
    db.prepare("INSERT INTO paymaster_usage(at, node, account, platform, tokens_json, headers_json) VALUES (?,?,?,?,?,?)").run(
      e.at ?? now(), "import", String(e.account ?? "unknown"), e.platform ?? null, JSON.stringify(e.tokens ?? e), JSON.stringify(e.headers ?? {})
    );
    bump("paymaster");
  }
  return accountsPath;
}

// ── 11. coord: best-effort slug matching; unmatched ARCHIVED not migrated ───
function importCoord() {
  const coordDir = path.join(HOME, "coord");
  if (!existsSync(coordDir)) return coordDir;
  // sha1 is one-way: enumerate dev-root repos, compute each old slug, match.
  const devRoot = readJson(path.join(HOME, "config.json"), {})?.dev_root ?? path.join(os.homedir(), "dev");
  const slugToRepo = new Map();
  const candidates = [REPO];
  try {
    for (const d of readdirSync(devRoot, { withFileTypes: true })) {
      if (d.isDirectory()) candidates.push(path.join(devRoot, d.name));
    }
  } catch { /* dev root unreadable — REPO alone */ }
  for (const repoPath of candidates) {
    const slug = crypto.createHash("sha1").update(path.resolve(repoPath)).digest("hex").slice(0, 16);
    slugToRepo.set(slug, repoPath);
  }
  const plansDir = path.join(coordDir, "plans");
  if (existsSync(plansDir)) {
    for (const f of readdirSync(plansDir).filter((f) => f.endsWith(".jsonl"))) {
      const slug = f.replace(/\.jsonl$/, "");
      const repoPath = slugToRepo.get(slug);
      if (!repoPath) { skip("coord-plans", slug, "unmatched legacy slug — ARCHIVED in place, not migrated"); continue; }
      let originUrl = null;
      try {
        originUrl = readFileSync(path.join(repoPath, ".git", "config"), "utf8").match(/url\s*=\s*(.+)/)?.[1]?.trim() ?? null;
      } catch { /* no git config */ }
      const repoKey = normalizeForImport(originUrl, repoPath);
      const lines = readFileSync(path.join(plansDir, f), "utf8").split("\n").filter((l) => l.trim());
      for (const line of lines) {
        let plan;
        try { plan = JSON.parse(line); } catch { continue; }
        if (DRY) { bump("coord-plans"); continue; }
        db.prepare("INSERT INTO plans(repo_key, session, at, payload_json) VALUES (?,?,?,?)").run(
          repoKey, String(plan.session ?? "import"), plan.releasedAt ?? plan.startedAt ?? now(), JSON.stringify(plan)
        );
        bump("coord-plans");
      }
    }
  }
  return coordDir;
}

function normalizeForImport(originUrl, repoPath) {
  if (originUrl) {
    let s = originUrl.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "").replace(/^[^@/]+@/, "");
    const scp = originUrl.match(/^[A-Za-z0-9._-]+@([^:/]+):(.+)$/);
    if (scp && !originUrl.includes("://")) s = `${scp[1]}/${scp[2]}`;
    s = s.replace(/\.git$/, "").replace(/\/+$/, "");
    const slash = s.indexOf("/");
    if (slash > 0) return `${s.slice(0, slash).toLowerCase()}${s.slice(slash)}`;
  }
  return `local:${SELF_NODE}:${crypto.createHash("sha1").update(path.resolve(repoPath)).digest("hex").slice(0, 16)}`;
}

// ── verify ──────────────────────────────────────────────────────────────────
function verify() {
  const checks = [];
  const kanbanDir = process.env.GARRISON_KANBAN_DIR?.trim() || path.join(HOME, "kanban-loop");
  const cardsDir = path.join(kanbanDir, "cards");
  if (existsSync(cardsDir)) {
    const fileCards = readdirSync(cardsDir).filter((id) => existsSync(path.join(cardsDir, id, "card.json")));
    const dbCards = db.prepare("SELECT COUNT(*) AS c FROM cards").get().c;
    checks.push({ what: "cards", files: fileCards.length, db: dbCards, ok: dbCards >= fileCards.length });
    for (const id of fileCards) {
      const row = db.prepare("SELECT body_json FROM cards WHERE id=?").get(id);
      if (!row) { report.mismatches.push(`card ${id} missing from DB`); continue; }
      const fileCard = readJson(path.join(cardsDir, id, "card.json"), {});
      const dbCard = JSON.parse(row.body_json);
      if (fileCard.list !== dbCard.list && !(fileCard.placement?.target === "host")) {
        report.mismatches.push(`card ${id} list drift: file=${fileCard.list} db=${dbCard.list}`);
      }
    }
  }
  const jobs = readJson(process.env.GARRISON_SCHEDULER_JOBS?.trim() || path.join(HOME, "scheduler-jobs.json"), []);
  const dbJobs = db.prepare("SELECT COUNT(*) AS c FROM scheduler_jobs").get().c;
  checks.push({ what: "scheduler-jobs", files: (jobs ?? []).length, db: dbJobs, ok: dbJobs >= (jobs ?? []).length });
  const secretCount = db.prepare("SELECT COUNT(*) AS c FROM secrets").get().c;
  checks.push({ what: "secrets", db: secretCount, ok: secretCount > 0 });
  report.verified.checks = checks;
  return checks.every((c) => c.ok) && report.mismatches.length === 0;
}

// ── main ────────────────────────────────────────────────────────────────────
const consumedSources = [];
if (VERIFY) {
  const ok = verify();
  console.log(JSON.stringify(report, null, 2));
  process.exit(ok ? 0 : 1);
}

const run = db.transaction(() => {
  consumedSources.push(importNodes());
  consumedSources.push(importSecrets());
  consumedSources.push(importLoadouts());
  importCompositions();
  consumedSources.push(importBoard());
  importOrigins();
  consumedSources.push(importSchedulerJobs());
  consumedSources.push(importFeedback());
  importAccounts();
  importCoord();
});
run();

if (FINALIZE && !DRY) {
  // Rollback is a rename. Compositions and the repo stay untouched — nodes
  // still materialise from the service; the FILES they came from are not
  // consumed (the kanban dir is, once the board migration lands).
  for (const src of consumedSources.filter(Boolean)) {
    if (existsSync(src) && !src.endsWith(".pre-mesh")) {
      try {
        renameSync(src, `${src}.pre-mesh`);
        console.log(`renamed ${src} -> ${src}.pre-mesh`);
      } catch (err) {
        console.error(`could not rename ${src}: ${err.message}`);
      }
    }
  }
}

console.log(JSON.stringify(report, null, 2));
if (DRY) console.log("\nDRY RUN — nothing written.");

// migrate-conversations.mjs — the ONE-TIME Conversations migration (v9 → v10).
//
// The board becomes five state columns and every legacy card freezes as
// read-only history; Backlog + To do cards are COPIED forward as fresh cards
// whose conversations start empty. Board and cards move in ONE pass — that is
// why migrateBoard's v10 entry is a guard, not a transform.
//
//   node migrate-conversations.mjs --dry-run    full plan, counts, every skip; no writes
//   node migrate-conversations.mjs              run it
//   node migrate-conversations.mjs --verify     re-read, assert the invariants, exit 1 on any miss
//   node migrate-conversations.mjs --rollback   restore the legacy board, unfreeze, delete the copies
//   node migrate-conversations.mjs --force      re-run over an already-migrated board
//
// Idempotency: frozen.at per card + migratedFrom on every copy — a second run
// without --force is a clean no-op printing the same verify report.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync, readFileSync, existsSync, cpSync } from "node:fs";
import {
  kanbanRoot,
  loadBoard,
  saveBoard,
  loadAllCards,
  createCard,
  boardStateClient,
  BOARD_NAMESPACE,
  BOARD_SCOPE,
  BOARD_VERSION,
} from "../lib/board.mjs";
import { buildBoard } from "../lib/resolved-model.mjs";

const FREEZE_REASON = "conversations-migration-v1";
const LEGACY_NAMESPACE = "board.layout.legacy";

// The contract: what a copied card CARRIES. Everything else deliberately does
// not travel — this list IS the migration's honesty. (Assert-the-exclusions
// lives in tests/kanban-conversations-migration.test.ts.)
export const CARRIED_FIELDS = [
  "title", "description", "project", "scope", "acceptance", "checklist", "goalMode",
];
// (events / placement / origin_id are absent here on purpose: createCard mints
// FRESH values for them — the contract is that no SOURCE state travels, and
// none of the source's values for those fields is ever read.)
export const EXCLUDED_FIELDS = [
  "schedule", "scheduledFor", "scheduleAction", "scheduleTemplateId", "scheduleSystemKey",
  "occurrenceKey", "occurrenceAt", "systemKey", "runId", "runDir", "sliceId",
  "duty", "level", "sequence", "flow", "phases", "routing", "tier", "briefPath",
  "waitingOn", "leaseFence", "originChannel",
  "lastDispatchError", "discussHeld", "autonomyHeld", "inferState", "dispatch",
  "sessionIds", "iterations", "handoff", "videoUrl", "lastReply", "runningSince",
  "parkedFrom", "attentionReason", "fences", "blocking", "preparedRevert",
];

function nodeName(client) {
  return String(client.node || process.env.GARRISON_NODE_NAME || "unknown").trim();
}

function isScheduleTemplate(card) {
  return card.list === "scheduled" || !!card.schedule || !!card.systemKey;
}

export function classifyCards(cards) {
  const templates = [];
  const copies = [];
  const freezes = [];
  for (const card of cards) {
    if (card.frozen?.at) continue; // already frozen (re-run)
    if (isScheduleTemplate(card)) templates.push(card);
    else if (card.list === "backlog" || card.list === "todo") copies.push(card);
    else freezes.push(card);
  }
  return { templates, copies, freezes };
}

async function snapshot(root, board, cards) {
  const dir = path.join(root, "migration");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `pre-conversations-${new Date().toISOString().replace(/[:]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify({ board, cards }, null, 2));
  return file;
}

async function freezeCard(client, card, by) {
  // The single-key {frozen} patch is the store guard's ONE escape.
  return client.patchCard(
    card.id,
    { frozen: { at: new Date().toISOString(), reason: FREEZE_REASON, by } },
    { ifMatchRev: card.rev ?? 0 }
  );
}

async function copyForward(root, card, order) {
  const fresh = await createCard(root, {
    title: card.title,
    description: card.description ?? "",
    project: card.project ?? null,
    scope: card.scope === "default" ? null : card.scope ?? null,
    list: "todo",
    goalMode: card.goalMode === true,
    acceptance: typeof card.acceptance === "string" ? card.acceptance : null,
    checklist: Array.isArray(card.checklist) ? card.checklist : null,
    position: order * 10,
  });
  const client = boardStateClient();
  const withProvenance = await client.patchCard(fresh.id, { migratedFrom: card.id }, { ifMatchRev: fresh.rev ?? 0 });
  // Side files travel on disk: the Discuss brief and the attachments folder.
  for (const rel of ["brief.md"]) {
    const src = path.join(root, "cards", card.id, rel);
    if (existsSync(src)) {
      mkdirSync(path.join(root, "cards", fresh.id), { recursive: true });
      cpSync(src, path.join(root, "cards", fresh.id, rel));
    }
  }
  const attSrc = path.join(root, "cards", card.id, "attachments");
  if (existsSync(attSrc)) {
    cpSync(attSrc, path.join(root, "cards", fresh.id, "attachments"), { recursive: true });
  }
  return withProvenance;
}

export async function verify(root) {
  const failures = [];
  const board = await loadBoard(root);
  const all = await boardStateClient().listCards({});
  const live = all.filter((c) => !c.frozen?.at);
  const frozen = all.filter((c) => c.frozen?.at);
  const copies = live.filter((c) => c.migratedFrom);
  const templates = live.filter((c) => isScheduleTemplate(c));

  // 1. board shape
  if (board.version !== 10) failures.push(`board version is ${board.version}, wanted 10`);
  const ids = (board.lists ?? []).map((l) => l.id);
  const wanted = ["todo", "running", "needs-attention", "scheduled", "done"];
  if (JSON.stringify(ids) !== JSON.stringify(wanted)) failures.push(`board lists are [${ids}], wanted [${wanted}]`);
  // 2. live census: every live card is a copy, a template, or born after the stamp
  const stamp = board.conversationsMigrated ?? null;
  if (!stamp) failures.push("board carries no conversationsMigrated stamp");
  for (const c of live) {
    if (c.migratedFrom || isScheduleTemplate(c)) continue;
    if (stamp && (c.created ?? "") >= stamp) continue; // born after migration — fine
    failures.push(`live card ${c.id} (${c.list}) is neither a copy, a template, nor post-migration`);
  }
  // 3. every copy's source is frozen
  for (const c of copies) {
    const src = all.find((x) => x.id === c.migratedFrom);
    if (!src) failures.push(`copy ${c.id} names missing source ${c.migratedFrom}`);
    else if (!src.frozen?.at) failures.push(`copy ${c.id}'s source ${src.id} is NOT frozen`);
  }
  // 4. no live card outside the five lists
  for (const c of live) {
    if (!wanted.includes(c.list)) failures.push(`live card ${c.id} sits on removed list ${c.list}`);
  }
  // 5. excluded fields absent on every copy — the whole list, not a spot-check
  for (const c of copies) {
    for (const field of EXCLUDED_FIELDS) {
      const v = c[field];
      if (v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0) && v !== false && v !== 0 && v !== "") {
        failures.push(`copy ${c.id} carries excluded field ${field}=${JSON.stringify(v).slice(0, 60)}`);
      }
    }
  }
  // 6. every frozen card's mirror carries frozen.at (board-summary reads it)
  for (const c of frozen) {
    const mirror = path.join(root, "cards", c.id, "card.json");
    if (existsSync(mirror)) {
      try {
        const m = JSON.parse(readFileSync(mirror, "utf8"));
        if (!m.frozen?.at) failures.push(`frozen card ${c.id}'s mirror lacks frozen.at`);
      } catch {
        failures.push(`frozen card ${c.id}'s mirror is unreadable`);
      }
    }
  }
  // 7. templates untouched: unfrozen, enabled schedules parse
  for (const t of templates) {
    if (t.frozen?.at) failures.push(`schedule template ${t.id} was frozen`);
    if (t.schedule?.enabled && t.schedule?.nextAt && !Number.isFinite(Date.parse(t.schedule.nextAt))) {
      failures.push(`template ${t.id} nextAt does not parse: ${t.schedule.nextAt}`);
    }
  }
  return { failures, counts: { total: all.length, live: live.length, frozen: frozen.length, copies: copies.length, templates: templates.length } };
}

export async function run({ dryRun = false, force = false } = {}) {
  const root = kanbanRoot();
  const client = boardStateClient();
  const by = nodeName(client);

  // Preflight — refuse loudly.
  const board = await loadBoard(root);
  if (board.version === 10 && !force) {
    const report = await verify(root);
    console.log(`already migrated (board v10). verify: ${report.failures.length ? report.failures.join("; ") : "OK"}`);
    console.log(JSON.stringify(report.counts));
    return report.failures.length ? 1 : 0;
  }
  if (board.version !== 9 && board.version !== 10) {
    console.error(`REFUSING: board version is ${board.version}; run the board once on current code first (it heals to 9)`);
    return 1;
  }
  const cards = await client.listCards({});
  const running = cards.filter((c) => !c.frozen?.at && c.status === "running");
  if (running.length && !force) {
    console.error(`REFUSING: ${running.length} card(s) are status running (${running.map((c) => c.id).join(", ")}) — freezing a live run makes a card that can never finish`);
    return 1;
  }
  const legacyDoc = await client.getConfig(LEGACY_NAMESPACE, BOARD_SCOPE).catch(() => null);
  if (legacyDoc?.body && !force) {
    console.error("REFUSING: board.layout.legacy already exists — this migration already ran (use --verify, or --force to re-run)");
    return 1;
  }

  const { templates, copies, freezes } = classifyCards(cards);
  console.log(`plan: ${templates.length} schedule template(s) untouched, ${copies.length} card(s) copied to To do, ${freezes.length} card(s) frozen`);
  if (dryRun) {
    for (const c of copies) console.log(`  copy   ${c.id} [${c.list}] ${String(c.title).slice(0, 60)}`);
    for (const c of freezes) console.log(`  freeze ${c.id} [${c.list}] ${String(c.title).slice(0, 60)}`);
    for (const t of templates) console.log(`  keep   ${t.id} [template] ${String(t.title).slice(0, 60)}`);
    console.log("dry run — nothing written");
    return 0;
  }

  // Snapshot EVERYTHING first.
  const snap = await snapshot(root, board, cards);
  console.log(`snapshot: ${snap}`);

  // Legacy board doc preserved for the History view.
  const boardDoc = await client.getConfig(BOARD_NAMESPACE, BOARD_SCOPE);
  const legacy = await client.getConfig(LEGACY_NAMESPACE, BOARD_SCOPE).catch(() => null);
  await client.putConfig(LEGACY_NAMESPACE, BOARD_SCOPE, boardDoc.body, { ifMatchRev: legacy?.rev ?? 0 });

  // Copy forward, preserving relative order (backlog before todo, then position).
  const ordered = [...copies].sort((a, b) => (a.list === b.list ? (a.position ?? 0) - (b.position ?? 0) : a.list === "backlog" ? -1 : 1));
  const copied = [];
  for (const [i, card] of ordered.entries()) {
    const already = cards.find((c) => c.migratedFrom === card.id && !c.frozen?.at);
    if (already) {
      copied.push(already);
      continue;
    }
    copied.push(await copyForward(root, card, i));
  }
  console.log(`copied ${copied.length} card(s) to To do`);

  // Freeze: sources of copies + everything else. Single-key patch (the escape),
  // then rewrite the mirror so board-summary sees it.
  let frozenCount = 0;
  for (const card of [...ordered, ...freezes]) {
    const fresh = await client.getCard(card.id);
    if (!fresh || fresh.frozen?.at) continue;
    const updated = await freezeCard(client, fresh, by);
    frozenCount += 1;
    // best-effort mirror rewrite (board-summary + History read it)
    try {
      const dir = path.join(root, "cards", card.id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "card.json"), JSON.stringify(updated, null, 2));
    } catch {
      /* mirror is a convenience */
    }
  }
  console.log(`froze ${frozenCount} card(s)`);

  // The new board, in ONE save: five lists, v10, the stamp.
  const rebuilt = {
    ...buildBoard(),
    projects: board.projects ?? {},
    rev: board.rev ?? 0,
    conversationsMigrated: new Date().toISOString(),
  };
  await saveBoard(rebuilt, root);
  console.log("board saved: five state columns, v10");

  // Retire the stale test beat (its list is gone); best-effort.
  try {
    const { schedulerCli } = await import("../lib/scheduler-beats.mjs");
    const { spawnSync } = await import("node:child_process");
    spawnSync("node", [schedulerCli(), "remove", "kanban-test-beat"], { stdio: "ignore" });
  } catch {
    /* absent scheduler CLI is fine */
  }

  const report = await verify(root);
  if (report.failures.length) {
    console.error("VERIFY FAILED:");
    for (const f of report.failures) console.error(`  - ${f}`);
    return 1;
  }
  console.log(`verify OK: ${JSON.stringify(report.counts)}`);
  return 0;
}

export async function rollback() {
  const root = kanbanRoot();
  const client = boardStateClient();
  const legacy = await client.getConfig(LEGACY_NAMESPACE, BOARD_SCOPE).catch(() => null);
  if (!legacy?.body) {
    console.error("nothing to roll back: no board.layout.legacy");
    return 1;
  }
  // Delete the copies, unfreeze this migration's freezes, restore the board.
  const cards = await client.listCards({});
  let deleted = 0;
  for (const c of cards) {
    if (c.migratedFrom && !c.frozen?.at) {
      await client.deleteCard(c.id, { ifMatchRev: c.rev ?? 0 });
      deleted += 1;
    }
  }
  let thawed = 0;
  for (const c of await client.listCards({ frozen: "1" })) {
    if (c.frozen?.reason === FREEZE_REASON) {
      await client.patchCard(c.id, { frozen: null }, { ifMatchRev: c.rev ?? 0 });
      thawed += 1;
    }
  }
  const boardDoc = await client.getConfig(BOARD_NAMESPACE, BOARD_SCOPE);
  await client.putConfig(BOARD_NAMESPACE, BOARD_SCOPE, legacy.body, { ifMatchRev: boardDoc?.rev ?? 0 });
  console.log(`rolled back: ${deleted} copies deleted, ${thawed} cards unfrozen, legacy board restored`);
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const arg = process.argv[2];
  let code = 0;
  if (arg === "--dry-run") code = await run({ dryRun: true });
  else if (arg === "--verify") {
    const report = await verify(kanbanRoot());
    if (report.failures.length) {
      for (const f of report.failures) console.error(`  - ${f}`);
      code = 1;
    } else {
      console.log(`verify OK: ${JSON.stringify(report.counts)}`);
    }
  } else if (arg === "--rollback") code = await rollback();
  else if (arg === "--force") code = await run({ force: true });
  else if (arg === undefined) code = await run({});
  else {
    console.log("usage: migrate-conversations.mjs [--dry-run | --verify | --rollback | --force]");
    code = 2;
  }
  process.exit(code);
}

// The two cross-node merge actions, both mediated by the state service.
//
// Neither of them merges anything on a peer. That asymmetry is deliberate:
//
//   pull-from-others  asks every other node to commit and push whatever it is
//                     sitting on, waits a bounded 120s, fetches, and REPORTS.
//                     The merge itself is the operator's (or the merge duty's)
//                     call, because merging under an agent's feet is exactly the
//                     failure this system exists to avoid.
//   push-to-others    commits and pushes THIS node's tree, then files one merge
//                     card per target node. The work then runs on the node that
//                     owns the tree, under the same lease/CAS/retry machinery
//                     every other card gets, and it is visible on the board. A
//                     silent cross-machine `git merge` is precisely the thing
//                     you want a record of.
//
// The executor on the receiving side is `commitPushProject` plus the pump at the
// bottom of this file: every node polls for `git.commit-push.request` events and
// answers with `git.commit-push.reply`. A node that says nothing is reported as
// `no-reply` and NEVER assumed clean - silence is the one answer you must not
// interpret optimistically.

import { readFileSync } from "node:fs";
import os from "node:os";

import { createStateClient, StateApiError, StateUnavailableError } from "../lib/state-client.mjs";
import { ulid } from "../lib/ulid.mjs";
import { gitCommitAll, gitFetch, gitHead, gitPush, gitStatus, hasOrigin } from "./git.mjs";
import { readDevRoot, resolveProjectName } from "./sources.mjs";

export { StateApiError, StateUnavailableError };

export const REQUEST_KIND = "git.commit-push.request";
export const REPLY_KIND = "git.commit-push.reply";

/** How long pull-from-others waits for the mesh before reporting what it has. */
export const REPLY_DEADLINE_MS = 120_000;
/** A request older than this is stale - the requester has long since reported. */
export const REQUEST_MAX_AGE_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 10_000;
const REPLY_POLL_MS = 3_000;

/** This machine's mesh identity. */
export function nodeName(env = process.env) {
  const explicit = String(env.GARRISON_NODE_NAME || "").trim();
  return explicit || os.hostname().split(".")[0];
}

let cachedClient;

/**
 * The state client, constructed once. Discovery THROWS when this node is not
 * enrolled, and that error is surfaced verbatim: there is no offline mode, and a
 * merge action that silently did nothing would be worse than a clear stop.
 */
export function stateClient(env = process.env) {
  if (cachedClient === undefined) cachedClient = createStateClient({ env, readFileSync });
  return cachedClient;
}

/** Test seam. */
export function setStateClient(client) {
  cachedClient = client;
}

/** Resolve a project label to its repo root on this node, or throw a 400-shaped error. */
export function projectRoot(project, env = process.env) {
  const cwd = resolveProjectName(project, { devRoot: readDevRoot(env) });
  if (!cwd) {
    const err = new Error(`no git project named "${project}" under this node's dev-root`);
    err.status = 400;
    throw err;
  }
  return cwd;
}

/**
 * Is an agent live in this tree? Merging or committing under a running session
 * commits half-written files, so this is a hard skip, not a warning.
 */
async function busyWithSession(client, cwd) {
  try {
    const sessions = await client.listSessions({ cwd, activeOnly: true });
    return Array.isArray(sessions) && sessions.length > 0 ? sessions : null;
  } catch {
    // A session registry we cannot read is not a licence to commit blind.
    return "unknown";
  }
}

/**
 * Commit whatever this node is sitting on and push it to origin on the CURRENT
 * branch. The single executor: the pump calls it, `POST /api/git/commit-push`
 * calls it, and push-to-others calls it before filing its cards.
 */
export async function commitPushProject(project, { env = process.env, client, message, force = false } = {}) {
  const cwd = projectRoot(project, env);
  const state = client ?? stateClient(env);

  if (!force) {
    const busy = await busyWithSession(state, cwd);
    if (busy === "unknown") {
      return { project, cwd, status: "skipped-unknown-sessions", detail: "the session registry was unreadable; refusing to commit blind" };
    }
    if (busy) {
      return {
        project,
        cwd,
        status: "skipped-session",
        detail: `${busy.length} active session(s) have this repository as cwd`,
        sessions: busy.map((s) => s.id ?? s.sessionId ?? null).filter(Boolean)
      };
    }
  }

  const status = await gitStatus(cwd);
  if (status.mergeInProgress) {
    return { project, cwd, status: "dirty-conflict", branch: status.branch, detail: `a ${status.inProgress.join("/")} is in progress` };
  }
  if (!status.branch) {
    return { project, cwd, status: "failed", detail: "HEAD is detached; nothing to push to" };
  }

  let committed = false;
  if (status.dirtyCount > 0) {
    const result = await gitCommitAll(cwd, message ?? `workspace: commit-push snapshot from ${nodeName(env)}`);
    committed = result.committed;
  }

  const sha = await gitHead(cwd);
  if (!(await hasOrigin(cwd))) {
    return { project, cwd, status: committed ? "committed-no-origin" : "no-origin", branch: status.branch, sha };
  }
  const push = await gitPush(cwd, status.branch);
  if (!push.ok) {
    return { project, cwd, status: "failed", branch: status.branch, sha, detail: push.output.slice(0, 500) };
  }
  return {
    project,
    cwd,
    status: committed ? "pushed" : status.ahead > 0 ? "pushed" : "clean",
    branch: status.branch,
    sha,
    committed
  };
}

function activePeers(nodes, self) {
  return (nodes ?? [])
    .filter((n) => n && n.name !== self && (n.status ?? "active") === "active")
    .map((n) => n.name);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Ask every other node to commit and push, wait out the deadline, fetch, and
 * report per node. The merge is NOT performed here - see the module header.
 */
export async function pullFromOthers(project, { env = process.env, client, now = () => Date.now(), deadlineMs = REPLY_DEADLINE_MS, pollMs = REPLY_POLL_MS } = {}) {
  const cwd = projectRoot(project, env);
  const state = client ?? stateClient(env);
  const self = nodeName(env);
  const requestId = ulid();
  const startedAt = now();
  const deadline = new Date(startedAt + deadlineMs).toISOString();

  const { seq } = await state.appendEvent({
    kind: REQUEST_KIND,
    subjectType: "project",
    subjectId: project,
    payload: { project, requestId, requestedBy: self, deadline }
  });

  const peers = activePeers(await state.listNodes(), self);
  const replies = new Map();

  while (peers.length && replies.size < peers.length && now() < startedAt + deadlineMs) {
    await sleep(pollMs);
    let events = [];
    try {
      events = await state.listEvents({ kind: REPLY_KIND, sinceSeq: seq, limit: 200 });
    } catch {
      // A blip in the state service costs one poll, not the whole action.
      continue;
    }
    for (const ev of events) {
      const p = ev.payload ?? {};
      if (p.requestId !== requestId) continue;
      const from = p.node ?? ev.node;
      if (!from || from === self || replies.has(from)) continue;
      replies.set(from, { ...p, node: from, at: ev.at });
    }
  }

  const fetched = await gitFetch(cwd);

  const nodes = peers.map((name) => {
    const reply = replies.get(name);
    if (!reply) return { node: name, status: "no-reply", branch: null, sha: null };
    return {
      node: name,
      status: "replied",
      result: reply.status ?? null,
      branch: reply.branch ?? null,
      sha: reply.sha ?? null,
      detail: reply.detail ?? null
    };
  });

  return {
    project,
    requestId,
    requestedBy: self,
    deadline,
    waitedMs: now() - startedAt,
    peers,
    nodes,
    fetch: fetched,
    // Said plainly so no caller has to infer it from an empty list.
    merged: false,
    note: "peers were asked to commit and push, and this node fetched. The merge itself is the merge duty's job."
  };
}

/** The instruction body a merge card carries day one. */
export function mergeCardBrief({ project, fromNode, fromBranch, fromSha, toNode }) {
  return [
    `\`${fromNode}\` pushed **${project}** and asks \`${toNode}\` to merge it.`,
    "",
    `- source branch: \`${fromBranch}\``,
    `- source sha: \`${fromSha ?? "(unknown)"}\``,
    `- project: \`${project}\``,
    "",
    "Run the `merge` duty's doctrine (`garrison-merge`) in this repository:",
    "",
    "1. `git fetch --all --prune`.",
    `2. Tag the pre-merge HEAD: \`git tag garrison/premerge/${project}/${toNode}/<ISO>\` — this tag IS the revert.`,
    `3. \`git merge --no-ff origin/${fromBranch}\`. Never \`-X ours\` or \`-X theirs\`.`,
    "4. Resolve any conflict file-by-file with both sides in full; the result must parse.",
    "5. REFUSE lockfiles (`package-lock.json`, `apm.lock.yaml`) and binaries — regenerate or escalate, never merge them.",
    "6. File a decision card on `needs-attention` for any non-trivial merge, carrying the tag, both shas, the conflict list and each resolution. A trivial fast-forward files nothing.",
    "",
    `Revert, if it goes wrong: \`git reset --hard garrison/premerge/${project}/${toNode}/<ISO>\`.`
  ].join("\n");
}

/**
 * Commit + push locally, then file one merge card per target node. Fully
 * autonomous by decision (2026-08-24): the rails are the pre-merge tag and the
 * decision card, not a human gate in front of every merge.
 */
export async function pushToOthers(project, { env = process.env, client, targets = null, force = false } = {}) {
  const state = client ?? stateClient(env);
  const self = nodeName(env);

  const local = await commitPushProject(project, { env, client: state, message: "workspace: push-to-others snapshot", force });
  if (!["pushed", "clean", "committed-no-origin"].includes(local.status)) {
    return { project, from: self, local, cards: [], note: "nothing was filed: this node could not publish its own branch" };
  }

  const peers = targets ?? activePeers(await state.listNodes(), self);
  const cards = [];
  for (const node of peers) {
    const id = ulid();
    const title = `merge ${project} from ${self}`;
    try {
      await state.createCard({
        id,
        list: "ops",
        title,
        project,
        description: mergeCardBrief({ project, fromNode: self, fromBranch: local.branch, fromSha: local.sha, toNode: node }),
        duty: "merge",
        placement: { target: node },
        routing: { duty: "merge", project },
        origin: "workspace-push-to-others",
        body: {
          kind: "merge-request",
          project,
          fromNode: self,
          fromBranch: local.branch,
          fromSha: local.sha,
          toNode: node
        }
      });
      cards.push({ node, cardId: id, title, status: "filed" });
    } catch (err) {
      cards.push({ node, cardId: null, title, status: "failed", detail: String(err?.message || err) });
    }
  }
  return { project, from: self, local, cards };
}

// ── the commit-push pump ─────────────────────────────────────────────────────
//
// One poll per node, every 10s, for requests this node has not answered. It
// lives here (rather than in a card) because it must work when the operative is
// DOWN - which is precisely when a node is behind and someone wants its work.

/** Has this node already replied to `requestId`? Checked against the service, not
 *  only against memory, so a restart cannot produce a duplicate reply. */
async function alreadyReplied(client, requestId, sinceSeq, self) {
  try {
    const replies = await client.listEvents({ kind: REPLY_KIND, sinceSeq, limit: 200 });
    return replies.some((ev) => (ev.payload?.requestId ?? null) === requestId && (ev.payload?.node ?? ev.node) === self);
  } catch {
    return true; // unreadable → do not risk a duplicate commit
  }
}

/** Handle exactly the requests visible after `sinceSeq`. Returns the new cursor. */
export async function pumpOnce({ client, env = process.env, sinceSeq = 0, now = () => Date.now(), log = () => {} } = {}) {
  const self = nodeName(env);
  let cursor = sinceSeq;
  let events = [];
  try {
    events = await client.listEvents({ kind: REQUEST_KIND, sinceSeq, limit: 50 });
  } catch (err) {
    log("listEvents failed", String(err?.message || err));
    return cursor;
  }
  for (const ev of events) {
    cursor = Math.max(cursor, ev.seq);
    const p = ev.payload ?? {};
    if (!p.project) continue;
    if ((p.requestedBy ?? ev.node) === self) continue; // never answer yourself
    const age = now() - Date.parse(ev.at);
    if (!Number.isFinite(age) || age > REQUEST_MAX_AGE_MS) continue; // stale: the requester has reported
    if (p.deadline && Date.parse(p.deadline) < now()) continue;
    if (await alreadyReplied(client, p.requestId, ev.seq - 1, self)) continue;

    let result;
    try {
      result = await commitPushProject(p.project, { env, client, message: `workspace: commit-push for ${p.project} (requested by ${String(p.requestedBy ?? "a peer").replace(/[^A-Za-z0-9._-]/g, "")})` });
    } catch (err) {
      result = { project: p.project, status: "failed", detail: String(err?.message || err) };
    }
    try {
      await client.appendEvent({
        kind: REPLY_KIND,
        subjectType: "project",
        subjectId: p.project,
        payload: {
          requestId: p.requestId ?? null,
          project: p.project,
          node: self,
          status: result.status,
          branch: result.branch ?? null,
          sha: result.sha ?? null,
          detail: result.detail ?? null
        }
      });
      log(`replied ${result.status} for ${p.project} (request ${p.requestId})`);
    } catch (err) {
      log("reply failed", String(err?.message || err));
    }
  }
  return cursor;
}

/**
 * Start the pump. Returns a stop function, or null when this node is not
 * enrolled in the mesh - an unenrolled node browses files perfectly well and
 * must not fail to boot over it.
 */
export function startCommitPushPump({ env = process.env, client, intervalMs = POLL_INTERVAL_MS, log = console.log } = {}) {
  let state;
  try {
    state = client ?? stateClient(env);
  } catch (err) {
    log(`[file-browser] mesh merge pump off: ${err?.message || err}`);
    return null;
  }
  let cursor = 0;
  let stopped = false;
  let timer = null;

  const tick = async () => {
    if (stopped) return;
    try {
      cursor = await pumpOnce({ client: state, env, sinceSeq: cursor, log: (...m) => log("[file-browser:merge]", ...m) });
    } catch (err) {
      log("[file-browser:merge] pump error", String(err?.message || err));
    }
    if (stopped) return;
    timer = setTimeout(tick, intervalMs);
    timer.unref?.();
  };

  // Start from the CURRENT tail, not from seq 0: a node that boots must not
  // walk a month of historical requests. (The 5-minute age filter in pumpOnce
  // makes that harmless either way — this just keeps the first tick cheap.)
  (async () => {
    try {
      for (;;) {
        const batch = await state.listEvents({ kind: REQUEST_KIND, sinceSeq: cursor, limit: 200 });
        if (!batch.length) break;
        cursor = batch[batch.length - 1].seq;
        if (batch.length < 200) break;
      }
    } catch {
      cursor = 0;
    }
    void tick();
  })();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

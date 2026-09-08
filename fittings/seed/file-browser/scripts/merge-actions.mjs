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

import { readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createStateClient, StateApiError, StateUnavailableError } from "../lib/state-client.mjs";
import { ulid } from "../lib/ulid.mjs";
import { gitCommitAll, gitFetch, gitHead, gitPush, gitStatus, hasOrigin, runGit, runGitOrThrow } from "./git.mjs";
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
 * Does a session's cwd sit in this tree? Compared by REAL path on both sides:
 * `projectRoot` is already canonical, but a session registers whatever path it
 * was spawned with, and on this mesh that is routinely a symlink (`~/dev` and
 * `~/Projects` point at each other machine by machine, macOS tmp dirs live under
 * /private). A string compare there fails OPEN - the guard exists so that never
 * happens. A session in a subdirectory is in the tree too.
 */
export function sessionInTree(sessionCwd, root) {
  if (typeof sessionCwd !== "string" || !sessionCwd) return false;
  let real;
  try {
    real = realpathSync(sessionCwd);
  } catch {
    real = path.resolve(sessionCwd);
  }
  return real === root || real.startsWith(`${root}${path.sep}`);
}

/**
 * Is an agent live in this tree? Merging or committing under a running session
 * commits half-written files, so this is a hard skip, not a warning. Only this
 * node's sessions are consulted: a peer's paths mean nothing on this disk.
 */
async function busyWithSession(client, cwd, env = process.env) {
  try {
    const sessions = await client.listSessions({ node: nodeName(env), activeOnly: true });
    const live = (Array.isArray(sessions) ? sessions : []).filter((s) => sessionInTree(s?.cwd, cwd));
    return live.length > 0 ? live : null;
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
    const busy = await busyWithSession(state, cwd, env);
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

  if (!(await hasOrigin(cwd))) {
    const sha0 = await gitHead(cwd);
    return { project, cwd, status: committed ? "committed-no-origin" : "no-origin", branch: status.branch, sha: sha0 };
  }

  // BEHIND-REMOTE HEAL. dev-madrid's converge (and the nightly card) may move
  // origin/<branch> while this node sleeps; a push from a strictly-behind
  // local is then rejected non-fast-forward — the first live cross-node pull
  // surfaced exactly that as an "error" reply. When we made NO commit and the
  // local is an ancestor of origin, fast-forwarding local IS the honest state;
  // then the push is a clean no-op. A genuinely diverged branch reports
  // "diverged" — a state the merge duty resolves, never a force-push.
  if (!committed) {
    await gitFetch(cwd);
    const remoteRef = `origin/${status.branch}`;
    const behind = await runGit(cwd, ["merge-base", "--is-ancestor", "HEAD", remoteRef], { cap: 1024 });
    const ahead = await runGit(cwd, ["merge-base", "--is-ancestor", remoteRef, "HEAD"], { cap: 1024 });
    if (behind.code === 0 && ahead.code !== 0) {
      await runGitOrThrow(cwd, ["merge", "--ff-only", remoteRef]);
    } else if (behind.code !== 0 && ahead.code !== 0) {
      const sha0 = await gitHead(cwd);
      return { project, cwd, status: "diverged", branch: status.branch, sha: sha0,
        detail: `local and ${remoteRef} have diverged - the merge duty resolves this, never a force-push` };
    }
  }

  const sha = await gitHead(cwd);
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

  const mergeResults = new Map();
  for (const [name, reply] of replies) {
    try {
      mergeResults.set(name, await mergeOneReply({ cwd, project, self, state, reply }));
    } catch (err) {
      mergeResults.set(name, { node: name, merge: "error", detail: String(err?.message ?? err) });
    }
  }

  const nodes = peers.map((name) => {
    const reply = replies.get(name);
    if (!reply) return { node: name, status: "no-reply", branch: null, sha: null, merge: "not-attempted" };
    const m = mergeResults.get(name) ?? {};
    return {
      node: name,
      status: "replied",
      result: reply.status ?? null,
      branch: reply.branch ?? null,
      sha: reply.sha ?? null,
      detail: reply.detail ?? null,
      merge: m.merge ?? "not-attempted",
      mergedSha: m.sha ?? null,
      premergeTag: m.tag ?? null
    };
  });

  const anyMerged = nodes.some((n) => n.merge === "merged");
  return {
    project,
    requestId,
    requestedBy: self,
    deadline,
    waitedMs: now() - startedAt,
    peers,
    nodes,
    fetch: fetched,
    merged: anyMerged,
    note: anyMerged
      ? "peers pushed, this node fetched AND merged (rails applied; conflicts card out)."
      : "peers were asked to commit and push, and this node fetched; nothing new to merge."
  };
}


// ── the local merge (the half "report-only day one" deferred) ───────────────
// After peers pushed and this node fetched, MERGE their branches into the
// current branch, under the merge doctrine's rails:
//   * a DIRTY local tree is never merged onto - skipped-dirty, honestly;
//   * already-contained shas report up-to-date and touch nothing;
//   * a real merge takes the premerge TAG first (revert = one command), then
//     `git merge --no-ff`; a conflict aborts CLEANLY and files a decision
//     card - never -X ours/theirs, never a half-merged tree;
//   * every non-trivial merge files its decision card; ff-shaped ones stay
//     silent so the rail keeps being read.
function premergeTagName(project, self, at = new Date()) {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\..*/, "Z");
  return `garrison/premerge/${project}/${self}/${stamp}`;
}

async function mergeOneReply({ cwd, project, self, state, reply }) {
  const sha = reply.sha;
  if (!sha) return { node: reply.node, merge: "no-sha" };
  const contains = await runGit(cwd, ["merge-base", "--is-ancestor", sha, "HEAD"], { cap: 1024 });
  if (contains.code === 0) return { node: reply.node, merge: "up-to-date" };

  const dirty = (await runGit(cwd, ["status", "--porcelain"], { cap: 64 * 1024 })).stdout.trim();
  if (dirty) return { node: reply.node, merge: "skipped-dirty" };

  const ffShaped = (await runGit(cwd, ["merge-base", "--is-ancestor", "HEAD", sha], { cap: 1024 })).code === 0;
  const tag = premergeTagName(project, self);
  await runGitOrThrow(cwd, ["tag", tag, "HEAD"]);
  const merged = await runGit(cwd, [
    "merge", "--no-ff", "-m",
    `mesh: merge ${reply.node}'s ${reply.branch ?? sha.slice(0, 8)} into ${self} (${tag})`,
    sha
  ], { timeoutMs: 60_000, cap: 256 * 1024 });

  if (merged.code !== 0) {
    await runGit(cwd, ["merge", "--abort"], { cap: 8192 });
    try {
      await state.createCard({
        id: ulid(),
        list: "needs-attention",
        title: `merge conflict: ${project} from ${reply.node}`,
        status: "idle",
        routing: { duty: "merge", project },
        description: [
          `Merging \`${reply.node}\`'s ${sha.slice(0, 12)} into \`${self}\` hit a conflict and was aborted cleanly.`,
          `Premerge tag: \`${tag}\` (revert = git reset --hard ${tag}).`,
          "Resolve per the merge doctrine: file-by-file, both sides in full, result must parse;",
          "lockfiles regenerate; never -X ours/theirs.",
          "", "```", (merged.stderr || merged.stdout).slice(0, 1500), "```"
        ].join("\n")
      });
    } catch { /* the conflict report must not die on a card hiccup */ }
    return { node: reply.node, merge: "conflict", tag };
  }

  const mergedSha = (await runGit(cwd, ["rev-parse", "HEAD"], { cap: 1024 })).stdout.trim();
  if (!ffShaped) {
    try {
      await state.createCard({
        id: ulid(),
        list: "done",
        title: `merged ${project}: ${reply.node} -> ${self}`,
        status: "done",
        routing: { duty: "merge", project },
        description: `Non-trivial merge of \`${reply.node}\`'s ${sha.slice(0, 12)} into \`${self}\` at ${mergedSha.slice(0, 12)}. Premerge tag \`${tag}\`; revert = git reset --hard ${tag}.`
      });
    } catch { /* decision record is best-effort; the merge itself already stands */ }
  } else {
    // ff-shaped: the tag was cheap insurance nobody needs to read about.
    await runGit(cwd, ["tag", "-d", tag], { cap: 4096 });
  }
  return { node: reply.node, merge: "merged", sha: mergedSha, tag: ffShaped ? null : tag };
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

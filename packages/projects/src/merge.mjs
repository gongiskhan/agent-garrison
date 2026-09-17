// Git actions run only in the resolved repository on this node.
// Peers exchange published refs and merge duty cards through shared state.

import { readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createStateClient, StateApiError, StateUnavailableError } from "@garrison/state-client";
import { ulid } from "./id.mjs";
import { assertRefArg, gitCommitAll, gitFetch, gitHead, gitPush, gitStatus, hasOrigin, runGit, runGitOrThrow } from "./git.mjs";

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
export function projectRoot(project, resolveProject) {
  const cwd = resolveProject?.(project);
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
 * branch. The single executor: the pump calls it, the Projects commit-push endpoint
 * calls it, and push-to-others calls it before filing its cards.
 */
export async function commitPushProject(project, { env = process.env, client, resolveProject, message, force = false } = {}) {
  const cwd = projectRoot(project, resolveProject);
  const state = client ?? stateClient(env);

  try {
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
        sessions: busy.length
      };
    }
  }

  const status = await gitStatus(cwd);
  if (status.mergeInProgress || status.dirty.some(entry => entry.state === 'conflict')) {
    return { project, cwd, status: "dirty-conflict", branch: status.branch, detail: `a ${status.inProgress.join("/")} is in progress` };
  }
  if (!status.branch) {
    return { project, cwd, status: "failed", detail: "HEAD is detached; nothing to push to" };
  }

  assertRefArg(status.branch);
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
  // local is then rejected non-fast-forward - the first live cross-node pull
  // surfaced exactly that as an "error" reply. When we made NO commit and the
  // local is an ancestor of origin, fast-forwarding local IS the honest state;
  // then the push is a clean no-op. A genuinely diverged branch reports
  // "diverged" - a state the merge duty resolves, never a force-push.
  if (!committed) {
    await gitFetch(cwd);
    const remoteRef = assertRefArg(`origin/${status.branch}`);
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
    return { project, cwd, status: /non-fast-forward|fetch first/i.test(push.output) ? "diverged" : "failed", branch: status.branch, sha, detail: push.output.slice(0, 500) };
  }
  return {
    project,
    cwd,
    status: committed ? "pushed" : status.ahead > 0 ? "pushed" : "clean",
    branch: status.branch,
    sha
  };
  } catch (error) {
    return {project, cwd, status: 'failed', detail: String(error?.message || error)};
  }
}

function activePeers(nodes, self) {
  return [...new Set((nodes ?? []).filter(node => node && node.name !== self && (node.status ?? 'active') === 'active').map(node => node.name))];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ask peers to publish, then merge only into the resolved tree on this node. */
export async function pullFromOthers(project, {env = process.env, client, resolveProject, now = () => Date.now(), deadlineMs = REPLY_DEADLINE_MS, pollMs = REPLY_POLL_MS} = {}) {
  const cwd = projectRoot(project, resolveProject), state = client ?? stateClient(env), self = nodeName(env);
  const requestId = ulid(), startedAt = now(), deadline = new Date(startedAt + deadlineMs).toISOString();
  const {seq} = await state.appendEvent({kind: REQUEST_KIND, subjectType: 'project', subjectId: project,
    payload: {project, requestId, requestedBy: self, deadline}});
  const peers = activePeers(await state.listNodes(), self), expected = new Set(peers), replies = new Map();
  while (peers.length && replies.size < peers.length && now() < startedAt + deadlineMs) {
    await sleep(pollMs);
    let events;
    try {events = await state.listEvents({kind: REPLY_KIND, sinceSeq: seq, limit: 200});}
    catch {continue;}
    for (const event of events) {
      const reply = event.payload ?? {}, from = reply.node ?? event.node;
      if (reply.requestId !== requestId || !expected.has(from) || replies.has(from)) continue;
      replies.set(from, {...reply, node: from});
    }
  }
  const fetched = await gitFetch(cwd), busy = await busyWithSession(state, cwd, env), nodes = [];
  for (const name of peers) {
    const reply = replies.get(name);
    if (!reply) {nodes.push({node: name, status: 'no-reply', branch: null, sha: null, merge: 'not-attempted'}); continue;}
    let result;
    try {
      if (!fetched.ok) result = {merge: 'not-attempted', detail: 'fetch failed on this node'};
      else if (busy === 'unknown') result = {merge: 'not-attempted', detail: 'skipped, the session registry could not be read'};
      else if (busy) result = {merge: 'not-attempted', detail: `skipped, ${busy.length} session${busy.length === 1 ? '' : 's'} working in this tree`};
      else result = await mergeOneReply({cwd, project, self, state, reply});
    } catch (error) {result = {merge: 'not-attempted', detail: String(error?.message || error)};}
    nodes.push({node: name, status: 'replied', branch: reply.branch ?? null, sha: reply.sha ?? null, merge: result.merge,
      ...(result.sha ? {mergedSha: result.sha} : {}), ...(result.cardId ? {cardId: result.cardId} : {}),
      ...(result.detail || reply.detail ? {detail: result.detail || reply.detail} : {})});
  }
  const merged = nodes.some(row => ['merged', 'fast-forward'].includes(row.merge));
  return {project, from: self, nodes, merged, note: !fetched.ok
    ? `Fetch failed: ${fetched.output.split(/\r?\n/)[0] || 'the origin did not answer'}.`
    : merged ? 'Peers published their branches, and this node fetched and merged their commits.'
      : 'Peers were asked to publish their branches. No new commits were merged on this node.'};
}

const LOCKFILES = new Set(['package-lock.json', 'apm.lock.yaml', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json', 'Cargo.lock', 'poetry.lock', 'uv.lock', 'Gemfile.lock', 'composer.lock', 'go.sum']);

function premergeTagName(project, self, at = new Date()) {
  return assertRefArg(`garrison/premerge/${project}/${self}/${at.toISOString().replace(/[-:.]/g, '')}`);
}

async function mergeDecision({state, project, self, reply, tag, reason}) {
  const card = {id: ulid(), list: 'needs-attention', title: `merge ${project}: ${reply.node} to ${self}`, status: 'idle',
    project, duty: 'merge', placement: {target: self}, routing: {duty: 'merge', project},
    description: [reason, '', `Source: ${reply.node}, ${reply.sha}.`, `Target: ${self}.`, `Pre-merge tag: ${tag}.`,
      `Revert: node scripts/garrison-converge.mjs revert ${project} ${tag}`,
      'Resolve file by file with both sides read in full. The result must parse.',
      'Regenerate lockfiles from the merged manifests. Refuse binaries. Never use -X ours or -X theirs.'].join('\n')};
  const stored = await state.createCard(card);
  return {...card, rev: stored.rev};
}

async function completeDecision(state, card, sha) {
  if (!card) return null;
  try {
    await state.patchCard(card.id, {list: 'done', status: 'done', description: `${card.description}\n\nCompleted at ${sha}. No conflicts required resolution.`}, {ifMatchRev: card.rev});
    return null;
  } catch {return 'The merge completed. Its decision card remains open because the final update failed.';}
}

async function mergeOneReply({cwd, project, self, state, reply}) {
  const sha = reply.sha;
  if (!['pushed', 'clean'].includes(reply.status)) return {merge: 'not-attempted', detail: reply.detail || 'the peer did not publish a branch'};
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(sha)) return {merge: 'not-attempted', detail: 'the peer did not return a valid commit'};
  const object = await runGit(cwd, ['cat-file', '-t', sha], {cap: 1024});
  if (object.code || object.stdout.trim() !== 'commit') return {merge: 'not-attempted', detail: 'the published commit was not available after fetch'};
  const contains = await runGit(cwd, ['merge-base', '--is-ancestor', sha, 'HEAD'], {cap: 1024});
  if (contains.code === 0) return {merge: 'up-to-date'};
  const status = await gitStatus(cwd);
  if (status.dirtyCount) return {merge: 'skipped-dirty'};
  if (status.mergeInProgress) return {merge: 'not-attempted', detail: `a ${status.inProgress.join('/')} is in progress`};
  const ffShaped = (await runGit(cwd, ['merge-base', '--is-ancestor', 'HEAD', sha], {cap: 1024})).code === 0;
  const tag = premergeTagName(project, self);
  await runGitOrThrow(cwd, ['tag', tag, 'HEAD']);
  const changes = await runGitOrThrow(cwd, ['diff', '--numstat', '--no-renames', '-z', 'HEAD', sha, '--'], {cap: 1024 * 1024});
  if (changes.truncated) {
    const card = await mergeDecision({state, project, self, reply, tag, reason: 'The change list exceeded its cap. Inspect the complete change set before merging.'});
    return {merge: 'conflict-card', cardId: card.id};
  }
  const files = changes.stdout.split('\0').filter(Boolean).map(row => {
    const first = row.indexOf('\t'), second = row.indexOf('\t', first + 1);
    return {path: row.slice(second + 1), binary: row.slice(0, first) === '-' && row.slice(first + 1, second) === '-'};
  });
  const refused = files.filter(file => file.binary || LOCKFILES.has(path.posix.basename(file.path)));
  if (refused.length) {
    const reason = ['This merge requires the merge duty before it can proceed.',
      ...refused.map(file => `${file.path}: ${file.binary ? 'binary refused' : 'regenerate this lockfile from the merged manifests; never merge it'}.`)].join('\n');
    const card = await mergeDecision({state, project, self, reply, tag, reason});
    return {merge: 'conflict-card', cardId: card.id};
  }
  // Record the decision before changing HEAD. A failed card write stops a
  // non-trivial merge, so a completed merge cannot lose its decision record.
  const card = ffShaped ? null : await mergeDecision({state, project, self, reply, tag,
    reason: 'Merge the published commits into this node with --no-ff. Preserve both histories and abort if any file conflicts.'});
  const merged = await runGit(cwd, ['merge', '--no-ff', '-m', `mesh: merge ${reply.node}'s ${reply.branch || sha.slice(0, 8)} into ${self} (${tag})`, sha], {timeoutMs: 60_000, cap: 256 * 1024});
  if (merged.code !== 0) {
    const abort = await runGit(cwd, ['merge', '--abort'], {cap: 8192});
    const detail = abort.code && (await gitStatus(cwd)).mergeInProgress
      ? 'The merge could not be aborted. The pre-merge tag is preserved; resolve this tree before trying again.'
      : 'The merge conflicted and was aborted. Resolve the files under the merge duty.';
    const decision = card ?? await mergeDecision({state, project, self, reply, tag, reason: detail});
    if (card) {
      try {await state.patchCard(card.id, {description: `${card.description}\n\n${detail}`}, {ifMatchRev: card.rev});}
      catch { /* The pre-written decision still carries both refs and the revert tag. */ }
    }
    return {merge: 'conflict-card', cardId: decision.id, detail};
  }
  const mergedSha = await gitHead(cwd), detail = await completeDecision(state, card, mergedSha);
  return {merge: 'merged', sha: mergedSha, ...(card ? {cardId: card.id} : {}), ...(detail ? {detail} : {})};
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
    `2. Tag the pre-merge HEAD: \`git tag garrison/premerge/${project}/${toNode}/<ISO>\` - this tag IS the revert.`,
    `3. \`git merge --no-ff origin/${fromBranch}\`. Never \`-X ours\` or \`-X theirs\`.`,
    "4. Resolve any conflict file-by-file with both sides in full; the result must parse.",
    "5. REFUSE lockfiles (`package-lock.json`, `apm.lock.yaml`) and binaries - regenerate or escalate, never merge them.",
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
export async function pushToOthers(project, { env = process.env, client, resolveProject, targets = null, force = false } = {}) {
  const state = client ?? stateClient(env);
  const self = nodeName(env);

  const local = await commitPushProject(project, { env, client: state, resolveProject, message: "workspace: push-to-others snapshot", force });
  if (!["pushed", "clean"].includes(local.status)) {
    return { project, from: self, local, cards: [], note: "nothing was filed: this node could not publish its own branch" };
  }

  const active = activePeers(await state.listNodes(), self);
  const peers = targets ? [...new Set(targets)].filter(node => active.includes(node)) : active;
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
// lives here (rather than in a card) because it must work when the composition is
// down - which is precisely when a node is behind and someone wants its work.

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
export async function pumpOnce({ client, resolveProject, env = process.env, sinceSeq = 0, now = () => Date.now(), log = () => {} } = {}) {
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
      result = await commitPushProject(p.project, { env, client, resolveProject, message: `workspace: commit-push for ${p.project} (requested by ${String(p.requestedBy ?? "a peer").replace(/[^A-Za-z0-9._-]/g, "")})` });
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
export function startCommitPushPump({ env = process.env, client, resolveProject, intervalMs = POLL_INTERVAL_MS, log = console.log } = {}) {
  let state;
  try {
    state = client ?? stateClient(env);
  } catch (err) {
    log(`[projects] mesh merge pump off: ${err?.message || err}`);
    return null;
  }
  let cursor = 0;
  let stopped = false;
  let timer = null;

  const tick = async () => {
    if (stopped) return;
    try {
      cursor = await pumpOnce({ client: state, resolveProject, env, sinceSeq: cursor, log: (...m) => log("[projects:merge]", ...m) });
    } catch (err) {
      log("[projects:merge] pump error", String(err?.message || err));
    }
    if (stopped) return;
    timer = setTimeout(tick, intervalMs);
    timer.unref?.();
  };

  // Start from the CURRENT tail, not from seq 0: a node that boots must not
  // walk a month of historical requests. (The 5-minute age filter in pumpOnce
  // makes that harmless either way - this just keeps the first tick cheap.)
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

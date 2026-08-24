// App-level mesh git actions — the buttons' backend, present on EVERY node
// whether or not a composition (and its workspace fitting) is up.
//
// Layering, not duplication: when the workspace fitting is ALIVE its
// full-railed pull (premerge tags, --no-ff, conflict cards) handles the
// action via loopback. When it is DEAD this floor still works, but merges
// FF-ONLY — the safe subset a floor may take on its own; anything non-trivial
// reports needs-workspace-merge instead of improvising rails. Push is the
// same everywhere: commit-push self, then file one merge card per active
// peer (fully autonomous by decision; the rails live with the merge duty
// that executes the card).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { withState } from "../state-client";
import { readNodeIdentity } from "../node-identity";
import { commitPushProject, resolveProjectDir } from "./git-executor";

const execFileAsync = promisify(execFile);
const GIT_BASE = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
  GIT_OPTIONAL_LOCKS: "0"
};

async function git(cwd: string, args: string[], timeout = 60_000): Promise<{ code: number; out: string; err: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", [...GIT_BASE, ...args], {
      cwd, env: GIT_ENV, timeout, maxBuffer: 1024 * 1024
    });
    return { code: 0, out: stdout, err: stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string; message?: string };
    return { code: typeof err.code === "number" ? err.code : 1, out: err.stdout ?? "", err: err.stderr ?? err.message ?? "" };
  }
}

export function listMeshProjects(): string[] {
  const projects = ["garrison"];
  try {
    const devRoot = readFileSync(path.join(process.env.GARRISON_HOME ?? path.join(os.homedir(), ".garrison"), "dev-root"), "utf8").trim();
    const root = devRoot || path.join(os.homedir(), "dev");
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      if (existsSync(path.join(root, entry.name, ".git"))) projects.push(entry.name);
    }
  } catch {
    try {
      const root = path.join(os.homedir(), "dev");
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        if (existsSync(path.join(root, entry.name, ".git"))) projects.push(entry.name);
      }
    } catch { /* no dev root */ }
  }
  return [...new Set(projects)];
}

function workspaceFittingUrl(): string | null {
  try {
    const home = process.env.GARRISON_HOME ?? path.join(os.homedir(), ".garrison");
    const status = JSON.parse(readFileSync(path.join(home, "ui-fittings", "file-browser.json"), "utf8"));
    return status?.url ?? null;
  } catch {
    return null;
  }
}

export interface MeshPullResult {
  project: string;
  via: "workspace-fitting" | "app-floor";
  nodes: { node: string; status: string; merge?: string; sha?: string | null; detail?: string | null }[];
  merged: boolean;
  note: string;
}

export async function meshPull(project: string): Promise<MeshPullResult> {
  const fitting = workspaceFittingUrl();
  if (fitting) {
    const res = await fetch(`${fitting}/api/git/pull-from-others`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project }),
      signal: AbortSignal.timeout(150_000)
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error ?? `workspace fitting ${res.status}`);
    return { project, via: "workspace-fitting", nodes: body.nodes ?? [], merged: Boolean(body.merged), note: body.note ?? "" };
  }

  // Floor: events + fetch + FF-ONLY merges.
  const dir = resolveProjectDir(project);
  const self = readNodeIdentity().id;
  const requestId = `pull-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const deadlineMs = 120_000;
  const started = Date.now();

  const { seq, peers } = await withState(async (c) => {
    const { seq } = await c.appendEvent({
      kind: "git.commit-push.request",
      subjectType: "project",
      subjectId: project,
      payload: { project, requestId, requestedBy: self, deadline: new Date(started + deadlineMs).toISOString() }
    });
    const nodes = await c.listNodes();
    return { seq, peers: nodes.filter((n) => n.name !== self && n.status === "active").map((n) => n.name) };
  });

  const replies = new Map<string, { sha?: string; branch?: string; status?: string; detail?: string }>();
  while (replies.size < peers.length && Date.now() - started < deadlineMs) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const events = await withState((c) => c.listEvents({ kind: "git.commit-push.reply", sinceSeq: seq, limit: 200 }));
      for (const ev of events) {
        const p = (ev.payload ?? {}) as { requestId?: string; node?: string; sha?: string; branch?: string; status?: string; result?: string; detail?: string };
        if (p.requestId !== requestId) continue;
        const from = p.node ?? ev.node;
        if (from && from !== self && !replies.has(from)) {
          replies.set(from, { sha: p.sha, branch: p.branch, status: p.status ?? p.result, detail: p.detail });
        }
      }
    } catch { /* one poll lost, not the action */ }
  }

  await git(dir, ["fetch", "--all", "--prune"], 120_000);
  const dirty = (await git(dir, ["status", "--porcelain"])).out.trim().length > 0;

  const nodes: MeshPullResult["nodes"] = [];
  let merged = false;
  for (const name of peers) {
    const reply = replies.get(name);
    if (!reply) { nodes.push({ node: name, status: "no-reply", merge: "not-attempted" }); continue; }
    if (!reply.sha) { nodes.push({ node: name, status: "replied", merge: "no-sha", detail: reply.detail }); continue; }
    const contains = await git(dir, ["merge-base", "--is-ancestor", reply.sha, "HEAD"]);
    if (contains.code === 0) { nodes.push({ node: name, status: "replied", merge: "up-to-date", sha: reply.sha }); continue; }
    if (dirty) { nodes.push({ node: name, status: "replied", merge: "skipped-dirty", sha: reply.sha }); continue; }
    const ffShaped = (await git(dir, ["merge-base", "--is-ancestor", "HEAD", reply.sha])).code === 0;
    if (!ffShaped) {
      nodes.push({ node: name, status: "replied", merge: "needs-workspace-merge", sha: reply.sha,
        detail: "non-trivial merge - bring the composition up (workspace fitting carries the rails) or run the merge duty" });
      continue;
    }
    const ff = await git(dir, ["merge", "--ff-only", reply.sha]);
    if (ff.code === 0) { merged = true; nodes.push({ node: name, status: "replied", merge: "merged", sha: reply.sha }); }
    else nodes.push({ node: name, status: "replied", merge: "error", sha: reply.sha, detail: ff.err.slice(0, 200) });
  }

  return {
    project, via: "app-floor", nodes, merged,
    note: merged ? "fetched and fast-forwarded (floor mode: ff-only)." : "fetched; nothing ff-able (floor mode merges ff-only)."
  };
}

export interface MeshPushResult {
  project: string;
  self: ReturnType<typeof commitPushProject> extends Promise<infer T> ? T : never;
  cards: { node: string; cardId: string }[];
}

export async function meshPush(project: string): Promise<MeshPushResult> {
  const selfResult = await commitPushProject(project);
  const selfName = readNodeIdentity().id;
  const cards: { node: string; cardId: string }[] = [];
  if (selfResult.result === "pushed" || selfResult.result === "nothing-to-push") {
    await withState(async (c) => {
      const nodes = await c.listNodes();
      for (const n of nodes) {
        if (n.name === selfName || n.status !== "active") continue;
        const id = `01${Array.from({ length: 24 }, () => "ABCDEFGHJKMNPQRSTVWXYZ0123456789"[Math.floor(Math.random() * 32)]).join("")}`;
        await c.createCard({
          id,
          list: "todo",
          title: `merge ${project} from ${selfName}`,
          status: "idle",
          placement: { target: n.name },
          routing: { duty: "merge", project },
          description: [
            `\`${selfName}\` pushed **${project}** (${selfResult.branch} @ ${selfResult.sha?.slice(0, 12)}) and asks \`${n.name}\` to merge it.`,
            "Doctrine: fetch, premerge tag, merge --no-ff, conflicts file-by-file (result must parse),",
            "lockfiles regenerate, never -X ours/theirs. Decision card for every non-trivial merge."
          ].join("\n")
        });
        cards.push({ node: n.name, cardId: id });
      }
    });
  }
  return { project, self: selfResult as MeshPushResult["self"], cards };
}

#!/usr/bin/env node
// Project Viewer HTTP server.
//
// Renders flow manifests on request rather than serving pre-rendered files. That
// matters for correctness, not just convenience: staleness badges and sample
// integrity depend on the LIVE state of the repository, so a page baked at
// analysis time would quietly start lying the moment HEAD moved — the exact
// failure this product exists to prevent. Rendering is a pure function of
// manifest plus git bytes, so it is cheap enough to do per request.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import * as git from "../lib/git.mjs";
import * as store from "../lib/store.mjs";
import * as render from "../lib/render.mjs";
import { verifyStepSample } from "../lib/samples.mjs";
import { splitByFile } from "../lib/diff.mjs";
import { addFindingSpans, buildFileIndex, uncommittedView } from "../lib/file-index.mjs";
import { buildDispatch } from "../lib/prompts.mjs";
import { dispatchCard, dispatchChat } from "../lib/dispatch.mjs";
import * as projects from "../lib/projects.mjs";
import { DEFAULT_LANG, LANGS, normaliseLang, t } from "../lib/i18n.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FITTING_DIR = path.resolve(HERE, "..");
const ASSETS_DIR = path.join(FITTING_DIR, "assets");
const DIST_DIR = path.join(FITTING_DIR, "dist");
const FITTING_ID = "project-viewer";

// ------------------------------------------------------------------ config

function expandHome(p) {
  const s = String(p ?? "");
  return s.startsWith("~") ? path.join(os.homedir(), s.slice(1)) : s;
}

export function readConfig(argv = process.argv.slice(2), env = process.env) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      args.set(k, v ?? argv[i + 1]);
    }
  }
  // Env projection for own-port fittings strips separators from the id:
  // project-viewer -> GARRISON_PROJECTVIEWER_<KEY>. No port is ever hardcoded;
  // it comes from the composition config, already shifted by the profile offset.
  const port = Number(args.get("port") ?? env.GARRISON_PROJECTVIEWER_PORT ?? env.PORT ?? 0);
  const host = args.get("host") ?? env.GARRISON_PROJECTVIEWER_HOST ?? "127.0.0.1";
  const repo = path.resolve(
    expandHome(args.get("repo") ?? env.GARRISON_PROJECTVIEWER_TARGET_REPO ?? process.cwd())
  );
  // The configured language is only the DEFAULT. A reader flips it per browser
  // with the toggle, which is why this is a cookie rather than a restart.
  const lang = normaliseLang(args.get("lang") ?? env.GARRISON_PROJECTVIEWER_LANGUAGE, DEFAULT_LANG);
  return { port, host, repo, lang };
}

/**
 * Resolve the reader's language: their own cookie first, then the composition's
 * configured default. Never the Accept-Language header — the interface language
 * is a deliberate choice here, not something to infer from a browser setting.
 */
function resolveLang(req, cfg) {
  const cookie = String(req.headers.cookie ?? "");
  const match = /(?:^|;\s*)pv_lang=([A-Za-z_-]+)/.exec(cookie);
  if (match) return normaliseLang(match[1], cfg.lang);
  return cfg.lang;
}

/**
 * Resolve which project this request is about.
 *
 * Per-browser, like the language, and for the same reason: the composition names a
 * default, but a reader looking at a second project should not be mutating what
 * everyone else sees. The cookie carries a KEY; the path it maps to comes from the
 * server's own registry, so a forged cookie can only ever name a project that was
 * already added deliberately. Anything unknown falls back to the configured repo
 * rather than erroring — a stale cookie (a project since removed) should degrade to
 * the default view, not to a broken one.
 */
async function resolveRepo(req, cfg) {
  const cookie = String(req.headers.cookie ?? "");
  const match = /(?:^|;\s*)pv_project=([a-f0-9]{6,64})/.exec(cookie);
  if (!match) return cfg.repo;
  const picked = await projects.resolveKey(match[1], { configured: cfg.repo }).catch(() => null);
  return picked ?? cfg.repo;
}

/**
 * Which view a flow opens in: the logic map, or the code walkthrough.
 *
 * Per-browser and sticky, like the language: the toggle stays where the reader
 * left it, across flows and across sessions. Code is the default because it is
 * the view the whole product was built around; the logic view is the summary a
 * reader opts into.
 */
function resolveFlowView(req) {
  const cookie = String(req.headers.cookie ?? "");
  return /(?:^|;\s*)pv_view=logic(?:;|$)/.test(cookie) ? "logic" : "code";
}

// ------------------------------------------------------------------ helpers

function send(res, status, body, type = "text/html; charset=utf-8", extra = {}) {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extra,
  });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj, null, 2), "application/json; charset=utf-8");
}

async function readBody(req, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  // A plain <form> is the right control for adding a project: it works with
  // JavaScript disabled and it survives a failed fetch, which a button that only
  // exists in JS does not. So both encodings are accepted — agents keep posting
  // JSON, browsers post a form, and neither has to know about the other.
  const type = String(req.headers["content-type"] ?? "");
  if (type.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("body is not valid JSON");
  }
}

/**
 * Where to send a reader back to after they flip the language.
 *
 * A Referer is attacker-controllable, so this is an allowlist rather than a
 * sanitiser: the result must be a path this server actually serves, or the reader
 * goes to the index. Taking `.pathname` alone would already drop a foreign host,
 * but two cases make that insufficient — a path that is itself protocol-relative
 * (`//attacker.example/x` in a Location header leaves the origin) and a junk path
 * that would land the reader on our own 404. Both end at "/" here.
 */
const RETURNABLE = [
  "/projects",
  "/findings",
  "/files",
  "/uncommitted",
  "/commits",
  "/docs",
  "/compare",
  "/flow/",
  "/commit/",
];

export function safeReturnPath(referer) {
  if (!referer) return "/";
  let candidate;
  try {
    candidate = new URL(String(referer), "http://placeholder.invalid");
  } catch {
    return "/";
  }
  const p = candidate.pathname || "/";
  if (!p.startsWith("/") || p.startsWith("//")) return "/";
  if (p === "/") return "/";
  if (!RETURNABLE.some((prefix) => p === prefix || p.startsWith(prefix))) return "/";
  return p + (candidate.search ?? "");
}

const MIME = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

/** Serve a static file, confined to `dir` — no traversal out of the asset roots. */
async function serveStatic(res, dir, relPath) {
  const target = path.resolve(dir, "." + path.posix.normalize("/" + relPath));
  if (!target.startsWith(path.resolve(dir) + path.sep) && target !== path.resolve(dir)) {
    return send(res, 403, "forbidden", "text/plain; charset=utf-8");
  }
  try {
    const st = await stat(target);
    if (!st.isFile()) throw new Error("not a file");
    const body = await readFile(target);
    return send(res, 200, body, MIME[path.extname(target)] ?? "application/octet-stream");
  } catch {
    return send(res, 404, "not found", "text/plain; charset=utf-8");
  }
}

// ------------------------------------------------------------------ status file

function statusFilePath(env = process.env) {
  const home = env.GARRISON_HOME ? expandHome(env.GARRISON_HOME) : path.join(os.homedir(), ".garrison");
  return path.join(home, "ui-fittings", `${FITTING_ID}.json`);
}

async function writeStatusFile(port, env = process.env) {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const file = statusFilePath(env);
  await mkdir(path.dirname(file), { recursive: true });
  const payload = {
    fittingId: FITTING_ID,
    port,
    url: `http://127.0.0.1:${port}`,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    route: "/",
    views: [{ id: FITTING_ID, title: "Project Viewer", route: "/" }],
  };
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return file;
}

async function removeStatusFile(env = process.env) {
  const { unlink } = await import("node:fs/promises");
  await unlink(statusFilePath(env)).catch(() => {});
}

// ------------------------------------------------------------------ rendering

/**
 * Resolve and verify every sample in a state, so the renderer receives bytes it
 * can trust. A step whose hash does not match arrives as { ok: false } and gets
 * an integrity panel instead of code.
 */
async function resolveState(repo, flow, state) {
  const samples = new Map();
  for (const step of state?.steps ?? []) {
    if (!step.sample && !step.diffSample) continue;
    try {
      samples.set(step.id, await verifyStepSample(repo, step, { sha: flow.anchoredAt?.sha }));
    } catch (err) {
      samples.set(step.id, { ok: false, error: err.message, expected: null, actual: null, text: null });
    }
  }
  return samples;
}

async function projectName(repo) {
  return path.basename(repo);
}

/**
 * The picker's rows, each carrying enough to decide without opening it.
 *
 * "Analysed" is the fact that matters: pointing the viewer at a repo nobody has run
 * the analysis on yields an empty viewer, and a picker that hides that difference
 * would make a first-run project look like a broken one. The flow count is read
 * per project, which is a handful of directory reads — cheap enough to be honest.
 */
async function describeProjects(cfg, current) {
  const list = await projects.listProjects({ configured: cfg.repo });
  return Promise.all(
    list.map(async (entry) => ({
      ...entry,
      isCurrent: entry.path === current,
      flows: (await store.listFlowIds(entry.path).catch(() => [])).length,
      isRepo: await git.isGitRepo(entry.path).catch(() => false),
    }))
  );
}

// ------------------------------------------------------------------ routes

async function handle(req, res, cfg) {
  const url = new URL(req.url, `http://${req.headers.host ?? "127.0.0.1"}`);
  const p = decodeURIComponent(url.pathname);
  const repo = await resolveRepo(req, cfg);

  if (p === "/health" || p === "/api/health") {
    let flows = [];
    let head = null;
    try {
      flows = await store.listFlowIds(repo);
      head = await git.headSha(repo).catch(() => null);
    } catch {
      /* health must answer even with a broken store */
    }
    return sendJson(res, 200, {
      ok: true,
      fittingId: FITTING_ID,
      repo,
      flows: flows.length,
      head,
      storeRoot: store.storeRoot(),
    });
  }

  if (p.startsWith("/assets/")) return serveStatic(res, ASSETS_DIR, p.slice("/assets/".length));
  if (p.startsWith("/dist/")) return serveStatic(res, DIST_DIR, p.slice("/dist/".length));

  // The language toggle. A GET that sets a cookie and returns the reader to
  // where they were, so every other link in the app stays clean — threading a
  // ?lang= param through every href would touch every render function and break
  // the moment one link forgot it.
  const langRoute = /^\/lang\/([A-Za-z_-]+)\/?$/.exec(p);
  if (langRoute) {
    const chosen = normaliseLang(langRoute[1], null);
    if (!LANGS.includes(chosen)) {
      return send(res, 404, "unsupported language", "text/plain; charset=utf-8");
    }
    const back = safeReturnPath(req.headers.referer);
    res.writeHead(303, {
      location: back,
      "set-cookie": `pv_lang=${chosen}; Path=/; Max-Age=31536000; SameSite=Lax`,
      "cache-control": "no-store",
    });
    return res.end();
  }

  // The logic/code view toggle. A GET that sets a cookie and lands on the flow it
  // was pressed in — carrying the flow id in the path instead of trusting the
  // referer, because the destination is data here, not just a way back. A state
  // page switching to logic goes to the flow's logic map, not "back": a state URL
  // is code-anchored and has no logic-view equivalent.
  const viewRoute = /^\/flow\/([^/]+)\/view\/(logic|code)\/?$/.exec(p);
  if (viewRoute) {
    res.writeHead(303, {
      location: `/flow/${encodeURIComponent(viewRoute[1])}`,
      "set-cookie": `pv_view=${viewRoute[2]}; Path=/; Max-Age=31536000; SameSite=Lax`,
      "cache-control": "no-store",
    });
    return res.end();
  }

  // The project switch. A GET that sets a cookie, mirroring the language toggle,
  // but it always returns to the index instead of to the referer: a flow id, a file
  // path or a commit sha belongs to the project it came from, so carrying the reader
  // back to the same deep link after a switch would land them on a 404 and make the
  // switch look broken. The index is the one page every project has.
  const projectRoute = /^\/project\/([a-f0-9]{6,64})\/?$/.exec(p);
  if (projectRoute) {
    const target = await projects.resolveKey(projectRoute[1], { configured: cfg.repo });
    if (!target) return send(res, 404, "unknown project", "text/plain; charset=utf-8");
    res.writeHead(303, {
      location: "/",
      "set-cookie": `pv_project=${projectRoute[1]}; Path=/; Max-Age=31536000; SameSite=Lax`,
      "cache-control": "no-store",
    });
    return res.end();
  }

  // ---- POST endpoints
  if (req.method === "POST" || req.method === "PATCH") {
    return handleMutation(req, res, cfg, p, repo);
  }

  const lang = resolveLang(req, cfg);
  const project = await projectName(repo);
  const flows = await store.listFlows(repo).catch(() => []);
  const findingsColl = await store.getFindings(repo).catch(() => ({ findings: [] }));
  const findings = findingsColl.findings ?? [];
  const index = await store.getIndex(repo).catch(() => ({ flowOrder: [], lastRefresh: null }));
  // The language the PROSE was authored in, set at intake. Read once per request
  // because three different pages carry prose and each has to be able to say so.
  const proseLang = index.proseLang ?? null;

  if (p === "/" || p === "/index.html") {
    const head = await git.headSha(repo).catch(() => null);
    return send(res, 200, render.renderIndex(flows, { project, findings, head, lastRefresh: index.lastRefresh, lang, proseLang }));
  }

  if (p === "/projects") {
    const rows = await describeProjects(cfg, repo);
    const notice = url.searchParams.get("error");
    return send(res, 200, render.renderProjects(rows, { project, lang, notice }));
  }

  if (p === "/findings") {
    return send(res, 200, render.renderFindings(findings, { project, flows, lang, proseLang }));
  }

  const flowState = /^\/flow\/([^/]+)(?:\/state\/(\d+))?\/?$/.exec(p);
  if (flowState) {
    const flowId = flowState[1];
    let flow;
    try {
      flow = await store.getFlow(repo, flowId);
    } catch (err) {
      return send(res, 500, render.renderError(500, err.message, { project, lang }));
    }
    if (!flow) return send(res, 404, render.renderError(404, `No flow called "${flowId}".`, { project, lang }));

    // No state in the URL means the landing view: the whole flow at a glance,
    // which is what the reader needs before deciding to walk through it. WHICH
    // glance — the logic map or the code outline — is the reader's standing
    // choice, carried by the view cookie. State URLs below ignore the cookie:
    // they are code-anchored and mean the same thing in either mode.
    if (flowState[2] === undefined) {
      if (resolveFlowView(req) === "logic") {
        return send(res, 200, render.renderFlowLogic(flow, { project, findings, lang, proseLang }));
      }
      return send(res, 200, render.renderFlowOutline(flow, { project, findings, lang, proseLang }));
    }

    const stateIndex = Number(flowState[2]);
    const state = (flow.states ?? [])[Math.max(0, Math.min(stateIndex, flow.states.length - 1))];
    const samples = await resolveState(repo, flow, state);
    return send(res, 200, render.renderFlowState(flow, { stateIndex, samples, findings, project, lang, proseLang }));
  }

  if (p === "/files") {
    const index = addFindingSpans(buildFileIndex(flows), findings);
    return send(res, 200, render.renderFileToFlows(index, { project, flows, lang }));
  }

  if (p.startsWith("/files/")) {
    const file = p.slice("/files/".length);
    const index = addFindingSpans(buildFileIndex(flows), findings);
    return send(res, 200, render.renderFileDetail(file, index[file] ?? [], { project, flows, lang }));
  }

  if (p === "/uncommitted") {
    const entries = await git.statusPorcelain(repo).catch(() => []);
    const index = buildFileIndex(flows);
    const view = uncommittedView(entries, index);
    const patch = await git.diffWorkingTree(repo).catch(() => "");
    const patches = splitByFile(patch);
    return send(res, 200, render.renderUncommitted(view, { project, flows, patches, lang }));
  }

  if (p === "/commits") {
    const commits = await git.recentCommits(repo, 20).catch(() => []);
    return send(res, 200, render.renderCommitList(commits, { project, flows, lang }));
  }

  const commit = /^\/commit\/([0-9a-fA-F]{7,40})\/?$/.exec(p);
  if (commit) {
    const sha = commit[1];
    try {
      const meta = await git.commitMeta(repo, sha);
      const patch = await git.commitPatch(repo, sha);
      return send(res, 200, render.renderCommitDiff(meta, splitByFile(patch), { project, lang }));
    } catch (err) {
      return send(res, 404, render.renderError(404, err.message, { project, lang }));
    }
  }

  if (p === "/docs") {
    const manifest = await store.getDocsManifest(repo).catch(() => ({ docs: [] }));
    return send(res, 200, render.renderDocsIndex(manifest.docs ?? [], { project, lang }));
  }

  const doc = /^\/docs\/([^/]+)\/?$/.exec(p);
  if (doc) {
    const manifest = await store.getDocsManifest(repo).catch(() => ({ docs: [] }));
    const entry = (manifest.docs ?? []).find((d) => d.docId === doc[1]);
    if (!entry) return send(res, 404, render.renderError(404, "No such document.", { project, lang }));
    // storedAt is repo-relative (store.consolidateDoc writes it that way) so the
    // copy travels with the repo; absolute paths keep working for older entries.
    const storedAt = entry.storedAt
      ? path.isAbsolute(entry.storedAt)
        ? entry.storedAt
        : path.join(repo, entry.storedAt)
      : null;
    const body = entry.body ?? (storedAt ? await readFile(storedAt, "utf8").catch(() => null) : null);
    return send(res, 200, render.renderDoc(entry, body ?? t(lang, "docs.missing"), { project, lang }));
  }

  if (p === "/compare") {
    const report = await store
      .readJson(path.join(store.cacheDir(repo), "compare-report.json"))
      .catch(() => null);
    return send(res, 200, render.renderCompare(report, { project, lang }));
  }

  // ---- JSON reads for agents
  if (p === "/api/flows") {
    return sendJson(
      res,
      200,
      flows.map((f) => ({
        flowId: f.flowId,
        title: f.title,
        source: f.source,
        states: (f.states ?? []).length,
        steps: (f.states ?? []).reduce((n, s) => n + (s.steps?.length ?? 0), 0),
        anchoredAt: f.anchoredAt ?? null,
      }))
    );
  }

  const apiFlow = /^\/api\/flow\/([^/]+)$/.exec(p);
  if (apiFlow) {
    const flow = await store.getFlow(repo, apiFlow[1]).catch(() => null);
    if (!flow) return sendJson(res, 404, { error: "not found" });
    return sendJson(res, 200, flow);
  }

  if (p === "/api/findings") return sendJson(res, 200, findingsColl);

  if (p === "/api/projects") {
    return sendJson(res, 200, { current: repo, projects: await describeProjects(cfg, repo) });
  }

  return send(res, 404, render.renderError(404, `Nothing at ${p}.`, { project, lang }));
}

async function handleMutation(req, res, cfg, p, repo) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }

  // Adding a project. Two entry points on purpose, one handler: `/projects/add`
  // answers a browser form with a redirect (so a mistyped path comes back as a
  // message on the page the reader is already looking at, with no JavaScript in the
  // path), `/api/projects` answers an agent with JSON.
  if ((p === "/projects/add" || p === "/api/projects") && req.method === "POST") {
    const result = await projects.addProject(body.path, { isRepo: (dir) => git.isGitRepo(dir) });
    if (p === "/api/projects") {
      return sendJson(res, result.ok ? 200 : 400, result);
    }
    if (!result.ok) {
      res.writeHead(303, {
        location: `/projects?error=${encodeURIComponent(result.code)}`,
        "cache-control": "no-store",
      });
      return res.end();
    }
    // Adding is also choosing. A reader who just typed a path wants to see it, and
    // making them click the row they just created is a step that exists only because
    // the implementation has two concepts.
    res.writeHead(303, {
      location: "/",
      "set-cookie": `pv_project=${result.key}; Path=/; Max-Age=31536000; SameSite=Lax`,
      "cache-control": "no-store",
    });
    return res.end();
  }

  if ((p === "/projects/remove" || p === "/api/projects/remove") && req.method === "POST") {
    const result = await projects.removeProject(body.key, { configured: cfg.repo });
    if (p === "/api/projects/remove") {
      return sendJson(res, result.ok ? 200 : 400, result);
    }
    // Forgetting the project you are currently reading has to clear the cookie too,
    // or the next page silently falls back to the default while the picker still
    // shows the removed row as current.
    const headers = {
      location: result.ok ? "/projects" : `/projects?error=${encodeURIComponent(result.code)}`,
      "cache-control": "no-store",
    };
    if (result.ok && result.path === repo) {
      headers["set-cookie"] = "pv_project=; Path=/; Max-Age=0; SameSite=Lax";
    }
    res.writeHead(303, headers);
    return res.end();
  }

  const finding = /^\/api\/findings\/([a-z0-9-]+)$/.exec(p);
  if (finding && req.method === "PATCH") {
    const status = body.status;
    if (!["open", "accepted", "dismissed", "fixed"].includes(status)) {
      return sendJson(res, 400, { error: "status must be open, accepted, dismissed or fixed" });
    }
    const updated = await store.setFindingStatus(repo, finding[1], status).catch((err) => {
      throw err;
    });
    if (!updated) return sendJson(res, 404, { error: "no such finding" });
    return sendJson(res, 200, { ok: true, finding: updated });
  }

  if (p === "/api/render" && req.method === "POST") {
    // Rendering is on-request, so there is no cache to bust yet; the endpoint
    // exists so the skill has one stable way to say "the data changed" and the
    // answer stays honest if a cache is added later.
    const flows = await store.listFlowIds(repo);
    return sendJson(res, 200, { ok: true, rerendered: flows.length, note: "pages render on request" });
  }

  const promptRoute = /^\/api\/prompt\/([a-z-]+)$/.exec(p);
  if (promptRoute && req.method === "POST") {
    const mode = promptRoute[1];
    try {
      const ctx = await buildContext(repo, mode, body);
      const { title, prompt, transport } = buildDispatch(mode, ctx);
      const result =
        transport === "chat"
          ? await dispatchChat({ prompt })
          : await dispatchCard({
              title,
              prompt,
              project: repo,
              // The dedupe key must carry the thing that makes this dispatch THIS
              // one. For a walkthrough that is the commit — flowId is always empty
              // there, so keying on it made two different commits collide, and the
              // second honest press came back "already queued". No sha means the
              // working tree, which is one queue-worthy job at a time by nature.
              originId: `project-viewer:${store.projectKey(repo)}:${mode}:${
                mode === "walkthrough" ? (body.sha ?? "uncommitted") : (body.flowId ?? "all")
              }`,
            });
      if (!result.ok) {
        // `code` travels so the client can say this in the reader's language; `error`
        // is the English fallback and the one that reaches the logs.
        return sendJson(res, result.status ?? 502, {
          error: result.error,
          ...(result.code ? { code: result.code } : {}),
          ...(result.instance ? { instance: result.instance } : {}),
          prompt,
        });
      }
      return sendJson(res, 200, { ok: true, ...result, prompt });
    } catch (err) {
      return sendJson(res, 400, { error: err.message, ...(err.code ? { code: err.code } : {}) });
    }
  }

  return sendJson(res, 404, { error: `no endpoint at ${p}` });
}

/** Assemble the context a prompt template needs, reading from the store. */
async function buildContext(repo, mode, body) {
  const base = { project: repo, flowId: body.flowId ?? null };
  if (mode === "fix-findings") {
    const coll = await store.getFindings(repo);
    const all = body.all === true;
    const picked = all
      ? coll.findings.filter((f) => f.status === "accepted")
      : coll.findings.filter((f) => (body.findingIds ?? []).includes(f.id));
    if (!picked.length) {
      throw new Error(all ? "no findings are marked accepted" : "no findings were selected");
    }
    return { ...base, findings: picked, all };
  }
  if (mode === "generate-tests") {
    if (!body.flowId) throw new Error("generate-tests needs a flowId");
    return base;
  }
  if (mode === "walkthrough") {
    // No sha is a scope, not an omission: it means the uncommitted working tree.
    // But an EMPTY working tree is an omission — dispatching a card to narrate
    // nothing wastes a run, so that one is refused here, where the button is
    // pressed, rather than discovered by the operative later.
    if (!body.sha) {
      const entries = await git.statusPorcelain(repo).catch(() => []);
      if (!entries.length) {
        const err = new Error("the working tree is clean — there is nothing to narrate");
        err.code = "treeClean"; // reaches the reader via the client's translation table
        throw err;
      }
      return { ...base, sha: null };
    }
    return { ...base, sha: body.sha };
  }
  if (mode === "ask") {
    if (!body.question) throw new Error("ask needs a question");
    return { ...base, stateIndex: body.stateIndex, stepId: body.stepId, question: body.question };
  }
  if (mode === "update") return { ...base, reason: body.reason ?? "" };
  return base;
}

// ------------------------------------------------------------------ probe

async function probe() {
  // Read-only, per the setup-vs-verify split: prove the package is intact and
  // that the pure modules load, and touch nothing.
  const required = [
    path.join(FITTING_DIR, "apm.yml"),
    path.join(FITTING_DIR, "dist", "index.html"),
    path.join(FITTING_DIR, "assets", "viewer.css"),
    path.join(FITTING_DIR, "assets", "viewer.js"),
    path.join(FITTING_DIR, "schema", "flow-manifest.schema.json"),
    path.join(FITTING_DIR, ".apm", "skills", "garrison-project-viewer", "SKILL.md"),
  ];
  for (const file of required) {
    await stat(file);
  }
  const { validateFlow } = await import("../lib/manifest.mjs");
  const bad = validateFlow({ schemaVersion: 1 });
  if (bad.ok) throw new Error("the manifest validator accepted an empty manifest");
  const { hashText } = await import("../lib/extract.mjs");
  if (hashText("") !== "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855") {
    throw new Error("sha256 hashing is not behaving as expected");
  }
  return true;
}

// ------------------------------------------------------------------ main

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--probe")) {
    try {
      await probe();
      process.stdout.write("ok\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(`probe failed: ${err.message}\n`);
      process.exit(1);
    }
  }

  const cfg = readConfig(argv);
  if (!cfg.port) {
    process.stderr.write(
      "project-viewer: no port configured. Pass --port or set GARRISON_PROJECTVIEWER_PORT " +
        "(the composition supplies it, already shifted for the instance profile).\n"
    );
    process.exit(1);
  }
  if (!(await git.isGitRepo(cfg.repo))) {
    process.stderr.write(
      `project-viewer: ${cfg.repo} is not a git repository. Every sample is anchored to a commit, ` +
        "so a repo is not optional.\n"
    );
    process.exit(1);
  }

  const server = createServer((req, res) => {
    handle(req, res, cfg).catch((err) => {
      process.stderr.write(`project-viewer: ${err.stack ?? err.message}\n`);
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
      else res.end();
    });
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      // No auto-shift: silently moving would hand the sidebar a stale port.
      process.stderr.write(`project-viewer: port ${cfg.port} is already in use.\n`);
      process.exit(1);
    }
    throw err;
  });

  await new Promise((resolve) => server.listen(cfg.port, cfg.host, resolve));
  await writeStatusFile(cfg.port);
  process.stdout.write(`project-viewer listening on http://${cfg.host}:${cfg.port} (repo: ${cfg.repo})\n`);

  const shutdown = async (signal) => {
    process.stdout.write(`project-viewer: ${signal}, shutting down\n`);
    await removeStatusFile();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return server;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`project-viewer failed to start: ${err.stack ?? err.message}\n`);
    process.exit(1);
  });
}

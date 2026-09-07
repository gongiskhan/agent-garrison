import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import * as store from "../fittings/seed/project-viewer/lib/store.mjs";
import { runCleanup, isHardExcluded } from "../fittings/seed/project-viewer/scripts/cleanup.mjs";
import { buildFromSpec } from "../fittings/seed/project-viewer/scripts/build-flow.mjs";
import { checkSpine, specFromCapture } from "../fittings/seed/project-viewer/lib/spine.mjs";
import { observedFiles } from "../fittings/seed/project-viewer/lib/compare.mjs";
import { renderCompare, renderFindings } from "../fittings/seed/project-viewer/lib/render.mjs";
import { commitDiffSamples, verifyStepSample } from "../fittings/seed/project-viewer/lib/samples.mjs";
import { readRegularText } from "../fittings/seed/project-viewer/lib/paths.mjs";
import { hashText } from "../fittings/seed/project-viewer/lib/extract.mjs";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-viewer-safety-")); roots.push(root);
  return root;
}
function git(root: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 3000,
    env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } }).trim();
}
async function repository() {
  const root = await fixture(); git(root, "init", "-q");
  await writeFile(path.join(root, "example.ts"), "export const example = 1;\n");
  git(root, "add", "example.ts"); git(root, "commit", "-qm", "fixture"); return root;
}

describe("Project Viewer trust boundaries", () => {
  it("protects executable directories under case-insensitive filesystem aliases", () => {
    expect(isHardExcluded(".CLAUDE/rules/private.md")).toBe(true);
    expect(isHardExcluded("././.claude//rules/private.md")).toBe(true);
    expect(isHardExcluded("./viewer/./docs/private.md")).toBe(true);
    expect(isHardExcluded("FITTINGS/seed/example/notes.md")).toBe(true);
  });
  it("bounds regular-file reads and never follows a final symlink", async () => {
    const root = await fixture(); const file = path.join(root, "bounded.md");
    await writeFile(file, "12345678");
    expect(readRegularText(file, 8)).toBe("12345678");
    expect(() => readRegularText(file, 7)).toThrow(/limit/);
    await symlink(file, path.join(root, "alias.md"));
    expect(() => readRegularText(path.join(root, "alias.md"), 8)).toThrow();
  });
  it("refuses spec traversal before creating files outside viewer", async () => {
    const root = await fixture();
    await expect(store.saveSpec(root, { flowId: "../../escaped" })).rejects.toThrow();
    await expect(readFile(path.join(root, "escaped.json"))).rejects.toThrow();
  });
  it("refuses a symlinked viewer directory for reads and writes", async () => {
    const root = await fixture(), outside = await fixture();
    await symlink(outside, path.join(root, "viewer"));
    await expect(store.saveIntake(root, { cleanupArmed: true })).rejects.toThrow();
    await expect(store.getIntake(root)).rejects.toThrow();
    await expect(readFile(path.join(outside, "intake.json"))).rejects.toThrow();
  });
  it("refuses to consolidate a source symlink outside the repository", async () => {
    const root = await fixture(), outside = await fixture();
    await writeFile(path.join(outside, "secret.md"), "fixture");
    await symlink(path.join(outside, "secret.md"), path.join(root, "source.md"));
    await expect(store.consolidateDoc(root, "source.md", { docId: "source", title: "Source" })).rejects.toThrow();
  });
  it("cannot delete the only copy by naming the original as consolidated", async () => {
    const root = await fixture(); await writeFile(path.join(root, "source.md"), "fixture");
    await store.saveIntake(root, { cleanupArmed: true });
    const entry = await store.consolidateDoc(root, "source.md", { docId: "source", title: "Source" });
    await store.saveDocsManifest(root, { docs: [{ ...entry, storedAt: "source.md" }] });
    await writeFile(store.cleanupAllowlistPath(root), JSON.stringify({ approvedAt: "2026-09-07", entries: [{ path: "source.md", reason: "fixture" }] }));
    expect((await runCleanup(root, { apply: true })).ok).toBe(false);
    expect(await readFile(path.join(root, "source.md"), "utf8")).toBe("fixture");
  });
  it("escapes untrusted line references in findings and cached compare reports", () => {
    const hostile = '<img src=x onerror="fixture()">';
    expect(renderFindings([{ id: "finding", text: "Fixture", flowId: "flow", span: { file: "example.ts", startLine: hostile } }])).not.toContain("<img");
    expect(renderCompare({ deadCode: [{ file: "example.ts", line: hostile }] })).not.toContain("<img");
  });
  it("verifies diff samples against Git rather than a self-supplied hash", async () => {
    const root = await repository(); const sha = git(root, "rev-parse", "HEAD");
    const [sample] = await commitDiffSamples(root, sha);
    expect((await verifyStepSample(root, { diffSample: sample })).ok).toBe(true);
    const patch = sample.patch.replace("example = 1", "example = 900");
    expect((await verifyStepSample(root, { diffSample: { ...sample, patch, extractedSha256: hashText(patch) } })).ok).toBe(false);
  });
  it("preserves runtime order when a flow revisits a page", () => {
    const capture = { events: ["/a", "/b", "/a"].map((url, seq) => ({ type: "action", action: "goto", seq, url })), test: { title: "Visit again" } };
    const spec = specFromCapture(capture);
    expect(checkSpine(spec, spec.spine).ok).toBe(true);
  });
  it("does not count a drillbook as observed execution", () => {
    expect([...observedFiles([{ status: "not-executed", source: "drillbook", events: [{ type: "route", file: "example.ts" }] }])]).toEqual([]);
  });
  it("preserves the authored functional explanation when materializing a spec", async () => {
    const root = await repository();
    const flow = await buildFromSpec(root, { flowId: "fixture", title: "Fixture", source: "e2e", states: [{ id: "start", label: "Start", logic: "Explain the result", steps: [{ id: "act", title: "Act", kind: "glue" }] }] });
    expect(flow.states[0].logic).toBe("Explain the result");
  });
});

// These probes use temporary repositories, loopback HTTP and synthetic transports.
import { createServer, request as httpRequest, type Server } from "node:http";
import { vi } from "vitest";
import { createRequestHandler } from "../fittings/seed/project-viewer/scripts/server.mjs";
import { dispatchCard, dispatchChat } from "../fittings/seed/project-viewer/lib/dispatch.mjs";
import { runProcess } from "../fittings/seed/project-viewer/lib/process.mjs";
import { updateRepo } from "../fittings/seed/project-viewer/scripts/update.mjs";
import { runPlaywright } from "../fittings/seed/project-viewer/scripts/capture-runtime.mjs";
import Reporter from "../fittings/seed/project-viewer/runtime/pv-reporter.mjs";

const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
});
async function serve(root: string) {
  const server = createServer(createRequestHandler({ repo: root, lang: "en" })); servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture address");
  return `http://127.0.0.1:${address.port}`;
}
async function peer() {
  const root = await fixture(); await mkdir(path.join(root, "ui-fittings"));
  await writeFile(path.join(root, "ui-fittings/kanban-loop.json"), JSON.stringify({ port: 1, url: "http://fixture.invalid" }));
  return { GARRISON_HOME: root };
}
const cardInput = { title: "Fixture", prompt: "Connectivity check; no file changes", project: "/fixture", originId: "fixture-origin" };

describe("Project Viewer bounded public requests", () => {
  it("refuses foreign-origin forms before changing the project registry", async () => {
    const root = await repository(); const base = await serve(root);
    const response = await fetch(`${base}/api/projects`, { method: "POST", headers: { origin: "https://foreign.invalid", "content-type": "application/x-www-form-urlencoded" }, body: `path=${encodeURIComponent(root)}` });
    expect(response.status).toBe(403);
  });
  it.each([
    ["public.fixture.invalid", "https://public.fixture.invalid", "same-origin", 403],
    ["node.tail-fixture.ts.net", "https://node.tail-fixture.ts.net", "cross-site", 403],
    ["node.tail-fixture.ts.net", "https://node.tail-fixture.ts.net", "same-origin", 200],
  ])("enforces browser host and fetch metadata for %s/%s/%s", async (host, origin, site, status) => {
    const root = await repository(); const base = await serve(root);
    const received = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(`${base}/api/render`, { method: "POST", headers: {
        host: String(host), origin: String(origin), "sec-fetch-site": String(site), "content-type": "application/json",
      } }, response => { response.resume(); response.once("end", () => resolve(response.statusCode)); });
      req.once("error", reject); req.end("{}");
    });
    expect(received).toBe(status);
  });
  it("does not expose a forged document storedAt through the actual HTTP route", async () => {
    const root = await repository(), outside = await fixture();
    await writeFile(path.join(outside, "private.md"), "OUTSIDE_FIXTURE_MARKER");
    await store.saveDocsManifest(root, { docs: [{ docId: "forged", title: "Forged", storedAt: path.join(outside, "private.md") }] });
    const response = await fetch(`${await serve(root)}/docs/forged`);
    expect(await response.text()).not.toContain("OUTSIDE_FIXTURE_MARKER");
  });
  it("canonicalizes a nested project to its Git checkout root", async () => {
    const root = await repository(), home = await fixture(); vi.stubEnv("GARRISON_HOME", home);
    const nested = path.join(root, "nested"); await mkdir(nested);
    const response = await fetch(`${await serve(root)}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: nested }) });
    expect(response.status).toBe(200);
    expect((await response.json()).path).toBe(await import("node:fs/promises").then(fs => fs.realpath(root)));
  });
  it("does not POST a job when the duplicate lookup fails", async () => {
    const env = await peer(); const fake = vi.fn(async () => new Response("unavailable", { status: 503 })); vi.stubGlobal("fetch", fake);
    expect((await dispatchCard(cardInput, env)).ok).toBe(false);
    expect(fake).toHaveBeenCalledTimes(1);
  });
  it("shares concurrent requests for one job and requires a real card receipt", async () => {
    const env = await peer(); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fake = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") { await gate; return Response.json({ cards: [] }); }
      expect(JSON.parse(String(init.body)).targetList).toBe("todo");
      return Response.json({ id: "fixture-card", list: "todo" });
    }); vi.stubGlobal("fetch", fake);
    const first = dispatchCard(cardInput, env), second = dispatchCard(cardInput, env);
    release(); const results = await Promise.all([first, second]);
    expect(results.map(result => result.cardId)).toEqual(["fixture-card", "fixture-card"]);
    expect(fake).toHaveBeenCalledTimes(2);
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => Response.json(init?.method === "POST" ? {} : { cards: [] })));
    expect((await dispatchCard(cardInput, env)).ok).toBe(false);
  });
  it.each(["request", "body"])("bounds a stalled %s even when the transport ignores abort", async phase => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return phase === "request" ? new Promise(() => {}) : Promise.resolve(new Response(new ReadableStream({ start() {} })));
    });
    const result = await dispatchChat({ prompt: "Fixture", timeoutMs: 25 }, { GARRISON_GATEWAY_URL: "http://fixture.invalid" });
    expect(result.ok).toBe(false); expect(signal?.aborted).toBe(true);
  });
});

describe("Project Viewer subprocess and capture boundaries", () => {
  it("terminates a hung subprocess and refuses excess retained output", async () => {
    await expect(runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 60 })).rejects.toThrow(/deadline/);
    await expect(runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(20000))"], { maxBytes: 1000 })).rejects.toThrow(/output limit/);
  });
  it("refuses an oversized unbroken line even when filtered output would be empty", async () => {
    await expect(runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(2*1024*1024))"], { keepLine: () => false })).rejects.toThrow(/line limit/);
  });
  it("runs only an installed fixture CLI and removes inherited live authority", async () => {
    const root = await repository(), rawOut = path.join(root, "raw"), pkg = path.join(root, "node_modules/@playwright/test");
    await mkdir(pkg, { recursive: true });
    await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "@playwright/test", exports: { "./cli": "./cli.cjs" } }));
    await writeFile(path.join(pkg, "cli.cjs"), "process.stdout.write(JSON.stringify({home:process.env.GARRISON_HOME,instance:process.env.GARRISON_INSTANCE_ID,port:process.env.PORT,authority:process.env.GARRISON_STATE_URL,claude:process.env.CLAUDE_CONFIG_DIR,args:process.argv.slice(2)}))");
    const result = await runPlaywright(root, { rawOut, env: { ...process.env, GARRISON_HOME: "/live", PORT: "8777", GARRISON_INSTANCE_ID: "node", GARRISON_STATE_URL: "https://authority.invalid" } });
    const child = JSON.parse(result.stdout);
    expect(child.home).toBe(path.join(rawOut, "test-home")); expect(child.authority).toBeUndefined();
    expect(child.instance).toBe("codex"); expect(child.port).toBeUndefined();
    expect(child.claude).toBe(path.join(rawOut, "test-home/claude")); expect(child.args[0]).toBe("test");
  });
  it("records ordered action metadata without input values or error bodies", async () => {
    const outputDir = await fixture(); const reporter = new Reporter({ outputDir });
    const test = { id: "fixture", title: "Neutral fixture", titlePath: () => ["", "Neutral fixture"], location: { file: "fixture.spec.ts" }, parent: { project: () => ({ name: "fixture" }) } };
    reporter.onBegin(); reporter.onTestBegin(test);
    reporter.onStepEnd(test, {}, { category: "pw:api", title: 'Fill "PRIVATE_FIXTURE_VALUE"', startTime: new Date(), duration: 1 });
    reporter.onStepEnd(test, {}, { category: "pw:api", title: 'Navigate to "https://user:PRIVATE_FIXTURE_VALUE@fixture.invalid/account?token=PRIVATE_FIXTURE_VALUE"', startTime: new Date(), duration: 1 });
    reporter.onTestEnd(test, { status: "failed", duration: 2, errors: [{ message: "PRIVATE_FIXTURE_VALUE" }] });
    const files = await import("node:fs/promises").then(fs => fs.readdir(outputDir));
    const text = await readFile(path.join(outputDir, files[0]), "utf8");
    expect(text).not.toContain("PRIVATE_FIXTURE_VALUE");
    expect(JSON.parse(text).actions.map((action: { title: string }) => action.title)).toEqual(["fill", "goto"]);
  });
});

describe("Project Viewer real Git acceptance", () => {
  it("keeps a partially refreshed span stable when updating twice to the same commit", async () => {
    const root = await repository();
    await writeFile(path.join(root, "example.ts"), "// header\nexport const first = 1;\n// gap\n// gap two\nexport const second = 2;\n");
    git(root, "add", "example.ts"); git(root, "commit", "-qm", "two spans");
    const flow = await buildFromSpec(root, { flowId: "partial", title: "Partial", source: "e2e", states: [{ id: "start", label: "Start", steps: [
      { id: "first", title: "First", kind: "code", file: "example.ts", startLine: 2, endLine: 2 },
      { id: "second", title: "Second", kind: "code", file: "example.ts", startLine: 5, endLine: 5 },
    ] }] }); await store.saveFlow(root, flow);
    await writeFile(path.join(root, "example.ts"), "// inserted\n// header\nexport const first = 1;\n// gap\n// gap two\nexport const second = 3;\n");
    git(root, "add", "example.ts"); git(root, "commit", "-qm", "shift and modify");
    await updateRepo(root); const once = await store.getFlow(root, "partial");
    expect(once.states[0].steps[0].sample.startLine).toBe(3);
    expect(once.states[0].steps[1].staleness.status).toBe("stale");
    await updateRepo(root); const twice = await store.getFlow(root, "partial");
    expect(twice.states[0].steps[0].sample).toEqual(once.states[0].steps[0].sample);
  });
  it("materializes six neutral flows and serves their verified code and logic", async () => {
    const root = await repository(); const base = await serve(root);
    for (let number = 1; number <= 6; number++) {
      const flowId = `fixture-${number}`;
      const flow = await buildFromSpec(root, { flowId, title: `Fixture flow ${number}`, source: "e2e", states: [{ id: "start", label: "Start", logic: `Fixture result ${number}`, steps: [{ id: "code", title: "Read example", kind: "code", file: "example.ts", startLine: 1, endLine: 1 }] }] });
      await store.saveFlow(root, flow);
      const response = await fetch(`${base}/flow/${flowId}`); const html = await response.text();
      expect(response.status).toBe(200); expect(html).toContain("example"); expect(html).not.toContain("integrity-failed");
      expect((await verifyStepSample(root, flow.states[0].steps[0])).ok).toBe(true);
    }
    expect((await store.getIndex(root)).flowOrder).toHaveLength(6);
    expect((await fetch(base).then(response => response.text())).match(/Fixture flow [1-6]/g)).toHaveLength(6);
  });
});

describe("Project Viewer concurrent metadata writes", () => {
  it("retains each independently registered flow and refresh metadata", async () => {
    const root = await fixture();
    await Promise.all([
      ...Array.from({ length: 6 }, (_, index) => store.registerFlow(root, `concurrent-${index}`)),
      store.recordRefresh(root, "a".repeat(40)),
    ]);
    const index = await store.getIndex(root);
    expect(index.flowOrder).toHaveLength(6);
    expect(index.lastRefresh.sha).toBe("a".repeat(40));
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
// @ts-ignore
import { createFixRunner, libraryChange, readFixJournal } from "../fittings/seed/preflight/lib/fixers.mjs";
// @ts-ignore
import { crossCheckLibrary } from "../fittings/seed/preflight/lib/preflight-core.mjs";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(entries: unknown[] = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), "preflight-fixers-"));
  roots.push(root);
  const home = path.join(root, "home");
  await mkdir(home);
  await mkdir(path.join(root, "data"));
  await mkdir(path.join(root, "fittings", "seed"), { recursive: true });
  const library = path.join(root, "data", "library.json");
  await writeFile(library, JSON.stringify(entries, null, 2) + "\n");
  const seed = async (id: string) => {
    const dir = path.join(root, "fittings", "seed", id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "apm.yml"), `name: ${id}\ndescription: |\n  A fixture fitting.\nx-garrison:\n  faculty: observability\n  verify: { command: 'echo ok' }\n`);
  };
  const getReport = async () => ({ findings: crossCheckLibrary(await readdir(path.join(root, "fittings", "seed")), JSON.parse(await readFile(library, "utf8"))) });
  // Executor transport is synthetic; the fitting validator itself is covered
  // by seed/validation tests and its real Preflight validation smoke.
  const exec = vi.fn(async () => ({ ok: true, out: "Overall: PASS", err: "" }));
  return { root, home, library, seed, getReport, exec };
}
const actionReport = (id: string, params: unknown) => async () => ({ findings: [{ action: { id, params } }] });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("Preflight repair executors", () => {
  it("revalidates stale findings before changing the registry", async () => {
    const f = await fixture();
    await f.seed("fixture-one");
    const run = createFixRunner({ ...f, env: {} });
    await writeFile(f.library, JSON.stringify([{ id: "fixture-one", localPath: "fittings/seed/fixture-one" }]));
    const before = await readFile(f.library, "utf8");
    expect(await run("library-add-entry", { fittingId: "fixture-one" })).toMatchObject({ ok: false, error: expect.stringMatching(/changed/) });
    expect(await readFile(f.library, "utf8")).toBe(before);
  });

  it("adds a valid seed without losing existing fields and journals the repair", async () => {
    const existing = { id: "remote", repo: "https://example.invalid/remote", custom: { keep: true } };
    const f = await fixture([existing]);
    await f.seed("fixture-one");
    const run = createFixRunner({ ...f, env: {} });
    expect(await run("library-add-entry", { fittingId: "fixture-one" })).toMatchObject({ ok: true });
    const entries = JSON.parse(await readFile(f.library, "utf8"));
    expect(entries[0]).toEqual(existing);
    expect(entries[1]).toMatchObject({ id: "fixture-one", summary: "A fixture fitting." });
    expect(await readdir(path.join(f.root, "data"))).toEqual(["library.json"]);
    expect(await readFixJournal(20, { home: f.home })).toEqual([expect.objectContaining({ actionId: "library-add-entry", params: { fittingId: "fixture-one" }, ok: true })]);
    expect(await readFixJournal(0, { home: f.home })).toEqual([]);
  });

  it("serializes concurrent registry repairs so neither overwrites the other", async () => {
    const f = await fixture();
    await f.seed("fixture-one");
    await f.seed("fixture-two");
    let inReport = false;
    const getReport = async () => {
      expect(inReport).toBe(false);
      inReport = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      const report = await f.getReport();
      inReport = false;
      return report;
    };
    const run = createFixRunner({ ...f, getReport, env: {} });
    expect(await Promise.all([run("library-add-entry", { fittingId: "fixture-one" }), run("library-add-entry", { fittingId: "fixture-two" })])).toEqual([expect.objectContaining({ ok: true }), expect.objectContaining({ ok: true })]);
    expect(JSON.parse(await readFile(f.library, "utf8")).map((entry: { id: string }) => entry.id)).toEqual(["fixture-one", "fixture-two"]);
  });

  it("refuses retired seeds even when an old report offers their registration", async () => {
    const f = await fixture();
    await f.seed("tier-classifier");
    const run = createFixRunner({ ...f, env: {}, getReport: actionReport("library-add-entry", { fittingId: "tier-classifier" }) });
    expect(await run("library-add-entry", { fittingId: "tier-classifier" })).toMatchObject({ ok: false, error: expect.stringMatching(/retired/) });
    expect(JSON.parse(await readFile(f.library, "utf8"))).toEqual([]);
  });

  it("refuses any seed rejected by the current platform validator, including retired capability kinds", async () => {
    const f = await fixture();
    await f.seed("invalid-seed");
    await writeFile(path.join(f.root, "fittings", "seed", "invalid-seed", "apm.yml"), 'name: invalid-seed\nx-garrison:\n  faculty: observability\n  verify: {command: "echo ok"}\n  provides: [{kind: soul}]\n');
    f.exec.mockResolvedValue({ ok: false, out: "Overall: FAIL", err: "" });
    const run = createFixRunner({ ...f, env: {} });
    expect(await run("library-add-entry", { fittingId: "invalid-seed" })).toMatchObject({ ok: false, error: expect.stringMatching(/fitting validation/) });
    expect(f.exec).toHaveBeenCalledWith(process.execPath, ["--import", "tsx", path.join(f.root, "scripts", "validate-fitting.ts"), path.join(f.root, "fittings", "seed", "invalid-seed")], expect.objectContaining({ cwd: f.root }));
    expect(JSON.parse(await readFile(f.library, "utf8"))).toEqual([]);
  });

  it("rechecks that a removed seed is still absent and refuses arbitrary registry removal", async () => {
    const entry = { id: "fixture-one", localPath: "fittings/seed/fixture-one" };
    const f = await fixture([entry, { id: "remote", repo: "https://example.invalid/remote" }]);
    await f.seed("fixture-one");
    const run = createFixRunner({ ...f, env: {}, getReport: async () => ({ findings: ["fixture-one", "remote"].map((entryId) => ({ action: { id: "library-remove-entry", params: { entryId } } })) }) });
    expect(await run("library-remove-entry", { entryId: "fixture-one" })).toMatchObject({ ok: false, error: expect.stringMatching(/directory exists/) });
    expect(await run("library-remove-entry", { entryId: "remote" })).toMatchObject({ ok: false, error: expect.stringMatching(/missing local seed/) });
    expect(JSON.parse(await readFile(f.library, "utf8"))).toHaveLength(2);
  });

  it("removes only a currently missing local seed", async () => {
    const f = await fixture([{ id: "gone", localPath: "fittings/seed/gone" }, { id: "remote", repo: "https://example.invalid/remote" }]);
    const run = createFixRunner({ ...f, env: {} });
    expect(await run("library-remove-entry", { entryId: "gone" })).toMatchObject({ ok: true });
    expect(JSON.parse(await readFile(f.library, "utf8"))).toEqual([{ id: "remote", repo: "https://example.invalid/remote" }]);
  });

  it.each([["constructor", {}], ["library-add-entry", { fittingId: ".." }], ["library-add-entry", { fittingId: "../escape" }], ["library-add-entry", { fittingId: "valid", command: "anything" }], ["tailscale-serve-map", { port: 70000 }]])("rejects unrecognized actions or parameters before collecting a report (%s)", async (action, params) => {
    const getReport = vi.fn();
    const run = createFixRunner({ env: {}, getReport });
    expect(await run(action, params)).toMatchObject({ ok: false });
    expect(getReport).not.toHaveBeenCalled();
  });

  it("unstations through only the configured app API and preserves other fields by omitting them", async () => {
    const f = await fixture();
    const fetchImpl = vi.fn().mockResolvedValueOnce(response({ composition: { name: "Keep", globalConfig: { keep: true }, selections: { observability: [{ id: "broken", config: {} }, { id: "keep", config: { port: 1234 } }] } } })).mockResolvedValueOnce(response({ composition: { selections: { observability: [{ id: "keep", config: { port: 1234 } }] } } }));
    const run = createFixRunner({ ...f, env: { GARRISON_APP_URL: "http://fixture.invalid" }, fetchImpl, getReport: actionReport("unstation-fitting", { compositionId: "fixture", fittingId: "broken" }) });
    expect(await run("unstation-fitting", { compositionId: "fixture", fittingId: "broken" })).toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [url, opts] = fetchImpl.mock.calls[1];
    expect(url).toBe("http://fixture.invalid/api/compositions/fixture");
    expect(opts.method).toBe("PUT");
    expect(opts.redirect).toBe("error");
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(opts.body)).toEqual({ selections: { observability: [{ id: "keep", config: { port: 1234 } }] } });
    expect(opts.headers).not.toHaveProperty("Authorization");
  });

  it("surfaces authority failures from the app without a second private push", async () => {
    const f = await fixture();
    const fetchImpl = vi.fn().mockResolvedValueOnce(response({ composition: { selections: { observability: [{ id: "broken" }] } } })).mockResolvedValueOnce(response({ error: "manifest saved locally but NOT to mesh" }, 400));
    const run = createFixRunner({ ...f, env: { GARRISON_APP_URL: "http://fixture.invalid" }, fetchImpl, getReport: actionReport("unstation-fitting", { compositionId: "fixture", fittingId: "broken" }) });
    expect(await run("unstation-fitting", { compositionId: "fixture", fittingId: "broken" })).toMatchObject({ ok: false, error: expect.stringMatching(/NOT to mesh/) });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each(["dev", "codex", "tethered", "unenrolled"])("refuses unsupported publication on %s without executing a command", async (mode) => {
    const f = await fixture();
    if (mode !== "unenrolled") await writeFile(path.join(f.home, "node.json"), JSON.stringify({ name: "fixture", tethered: mode === "tethered" }));
    const exec = vi.fn();
    const run = createFixRunner({ ...f, env: { GARRISON_INSTANCE_ID: ["dev", "codex"].includes(mode) ? mode : "node" }, exec, getReport: actionReport("tailscale-serve-map", { port: 8076 }) });
    expect(await run("tailscale-serve-map", { port: 8076 })).toMatchObject({ ok: false });
    expect(exec).not.toHaveBeenCalled();
  });

  it("delegates node publication to the supported script without --force or arbitrary tailscale arguments", async () => {
    const f = await fixture();
    await writeFile(path.join(f.home, "node.json"), JSON.stringify({ name: "fixture" }));
    const exec = vi.fn(async () => ({ ok: true, out: "", err: "" }));
    const run = createFixRunner({ ...f, env: { GARRISON_INSTANCE_ID: "node" }, exec, getReport: actionReport("tailscale-serve-map", { port: 8076 }) });
    expect(await run("tailscale-serve-map", { port: 8076 })).toMatchObject({ ok: true });
    expect(exec).toHaveBeenCalledWith(process.execPath, [path.join(f.root, "scripts", "tailnet-serve-views.mjs")], expect.objectContaining({ timeout: 60_000 }));
  });
});

function gitTransport() {
  const state = { head: "head-one\n", diff: "diff --git a/data/library.json b/data/library.json\n-old\n+reviewed\n", staged: "staged library changes\n" };
  const exec = vi.fn(async (_cmd: string, args: string[]) => {
    const out = args.includes("rev-parse") ? state.head : args.includes("diff") ? args.includes("--cached") ? state.staged : state.diff : "";
    return { ok: true, out, err: "" };
  });
  return { state, exec };
}

describe("Preflight reviewed registry commit", () => {
  it.each(["head", "diff", "staged"] as const)("rejects a changed %s after the displayed diff was reviewed", async (key) => {
    const f = await fixture();
    const { state, exec } = gitTransport();
    const reviewed = await libraryChange(f.root, exec);
    state[key] += "changed";
    const run = createFixRunner({ ...f, env: {}, exec });
    expect(await run("git-commit-library", { diffHash: reviewed.diffHash })).toMatchObject({ ok: false, error: expect.stringMatching(/changed/) });
    expect(exec.mock.calls.some(([, args]) => args.includes("commit") || args.includes("add"))).toBe(false);
  });

  it("commits only the unchanged reviewed file without staging or pushing other paths", async () => {
    const f = await fixture();
    const { exec } = gitTransport();
    const reviewed = await libraryChange(f.root, exec);
    expect(reviewed.diff).toContain("+reviewed");
    const run = createFixRunner({ ...f, env: {}, exec });
    expect(await run("git-commit-library", { diffHash: reviewed.diffHash })).toMatchObject({ ok: true });
    const writes = exec.mock.calls.filter(([, args]) => args.includes("commit") || args.includes("add") || args.includes("push"));
    expect(writes).toEqual([["git", ["-C", f.root, "commit", "--only", "-m", "preflight: update reviewed fitting registry", "--", "data/library.json"]]]);
  });

  it("does not offer a commit for a missing or oversized diff", async () => {
    const { state, exec } = gitTransport();
    state.diff = "";
    expect(await libraryChange("fixture", exec)).toEqual({ diff: null, diffHash: null });
    state.diff = "x".repeat(200_001);
    expect(await libraryChange("fixture", exec)).toMatchObject({ diffHash: null });
  });
});

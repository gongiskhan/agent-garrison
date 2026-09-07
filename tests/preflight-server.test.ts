import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import http, { type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
// @ts-ignore — the fitting's standalone module deliberately has no TS dependency.
import { clearStatusFile, createRequestHandler, startServer, writeStatusFile } from "../fittings/seed/preflight/scripts/server.mjs";

const servers: Server[] = [];
let root: string;
let distDir: string;
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    distDir,
    buildReport: vi.fn(async () => ({ findings: [], summary: { overall: "pass" } })),
    runFix: vi.fn(async () => ({ ok: true })),
    runVerifySweep: vi.fn(async () => ({ ok: true, results: [] })),
    isAppUp: vi.fn(async () => true),
    fetchRunnerState: vi.fn(async () => ({ status: "idle" })),
    ...overrides
  };
}
async function listen(deps = dependencies(), onRequest?: (req: http.IncomingMessage) => void) {
  const handler = createRequestHandler(deps);
  const server = http.createServer((req, res) => { onRequest?.(req); void handler(req, res); });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture port");
  return { server, port: address.port, base: `http://127.0.0.1:${address.port}` };
}
function request(port: number, route: string, body?: string, headers: IncomingHttpHeaders = {}, method = body === undefined ? "GET" : "POST", headersOnly = false) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: route, method, agent: false,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.once("end", () => { resolve({ status: res.statusCode!, text }); req.destroy(); });
      res.once("error", reject);
    });
    req.once("error", reject);
    // A header rejection must arrive before an upload is required. Continuing
    // a large rejected upload can race the peer's close into an OS-level reset.
    if (headersOnly) {
      req.setTimeout(5000, () => req.destroy(new Error("timed out waiting for header rejection")));
      req.flushHeaders();
    }
    else req.end(body);
  });
}
const fixBody = JSON.stringify({ actionId: "fixture-repair", params: { fittingId: "fixture" } });
const sweepBody = JSON.stringify({ compositionId: "fixture" });

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "garrison-preflight-http-"));
  distDir = path.join(root, "dist");
  await mkdir(distDir);
  await mkdir(path.join(root, "dist-sibling"));
  await writeFile(path.join(distDir, "index.html"), "fixture view");
  await writeFile(path.join(root, "dist-sibling", "secret.txt"), "outside sentinel");
  await symlink(path.join(root, "dist-sibling", "secret.txt"), path.join(distDir, "escape.txt"));
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
  vi.restoreAllMocks();
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe("Preflight HTTP mutation boundary", () => {
  it("accepts server-to-server calls and a matching HTTPS published host", async () => {
    const deps = dependencies();
    const { port, base } = await listen(deps);
    expect((await request(port, "/api/fix", fixBody)).status).toBe(200);
    expect((await request(port, "/api/fix", fixBody, { origin: base })).status).toBe(200);
    expect((await request(port, "/api/fix", fixBody, {
      host: "fixture.tail31efa.ts.net:8476", origin: "https://fixture.tail31efa.ts.net:8476"
    })).status).toBe(200);
    expect(deps.runFix).toHaveBeenCalledTimes(3);
  });

  it.each([
    { origin: "https://unrelated.example" },
    { origin: "null" },
    { origin: "http://localhost:1" },
    { origin: "https://fixture.tail31efa.ts.net:8476", host: "other.tail31efa.ts.net:8476" },
    { origin: "https://untrusted.example", host: "untrusted.example" },
    { "sec-fetch-site": "cross-site" }
  ])("rejects cross-site, opaque or rebound requests: %j", async (headers) => {
    const deps = dependencies();
    const { port } = await listen(deps);
    expect((await request(port, "/api/fix", fixBody, headers)).status).toBe(403);
    expect((await request(port, "/api/verify-sweep", sweepBody, headers)).status).toBe(403);
    expect(deps.runFix).not.toHaveBeenCalled();
    expect(deps.runVerifySweep).not.toHaveBeenCalled();
  });

  it.each(["text/plain", "application/x-www-form-urlencoded", "application/jsonp", ""])("requires JSON, refusing %s", async (type) => {
    const deps = dependencies();
    const { port } = await listen(deps);
    expect((await request(port, "/api/fix", fixBody, { "content-type": type })).status).toBe(415);
    expect(deps.runFix).not.toHaveBeenCalled();
  });

  it.each(["{", "", "[]", "null", "3", '{"actionId":"fixture-repair","params":[]}'])("rejects malformed/non-object input %s", async (body) => {
    const deps = dependencies();
    const { port } = await listen(deps);
    expect((await request(port, "/api/fix", body)).status).toBe(400);
    expect(deps.runFix).not.toHaveBeenCalled();
  });

  it("enforces the byte limit for both declared and streamed multibyte bodies", async () => {
    const deps = dependencies();
    const { port } = await listen(deps);
    const body = JSON.stringify({ actionId: "fixture-repair", params: { text: "é".repeat(530_000) } });
    expect(body.length).toBeLessThan(1024 * 1024);
    expect((await request(port, "/api/fix", undefined, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }, "POST", true)).status).toBe(413);
    expect((await request(port, "/api/fix", body, { "transfer-encoding": "chunked" })).status).toBe(413);
    expect(deps.runFix).not.toHaveBeenCalled();
  });

  it("settles an aborted partial body and remains usable without applying it", async () => {
    const deps = dependencies();
    const entered = gate();
    const settled = gate();
    const handler = createRequestHandler(deps);
    const server = http.createServer((req, res) => {
      entered.release();
      void handler(req, res).finally(settled.release);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as import("node:net").AddressInfo).port;
    const req = http.request({ host: "127.0.0.1", port, path: "/api/fix", method: "POST",
      headers: { "content-type": "application/json", "content-length": "200" } });
    req.on("error", () => {});
    req.write('{"actionId":');
    await entered.promise;
    req.destroy();
    await settled.promise;
    expect(deps.runFix).not.toHaveBeenCalled();
    expect((await request(port, "/api/fix", fixBody)).status).toBe(200);
  });
});

describe("Preflight serialized live operations", () => {
  it.each([null, {}, ...["running", "installing", "starting", "verifying", "stopping", "unknown"].map((status) => ({ status }))])(
    "refuses verify unless the fresh state is idle/failed: %j", async (state) => {
      const deps = dependencies({ fetchRunnerState: vi.fn(async () => state) });
      const { port } = await listen(deps);
      expect((await request(port, "/api/verify-sweep", sweepBody)).status).toBe(409);
      expect(deps.runVerifySweep).not.toHaveBeenCalled();
    }
  );

  it.each(["idle", "failed"])("allows a fresh %s composition", async (status) => {
    const deps = dependencies({ fetchRunnerState: vi.fn(async () => ({ status })) });
    const { port } = await listen(deps);
    expect((await request(port, "/api/verify-sweep", sweepBody)).status).toBe(200);
    expect(deps.fetchRunnerState).toHaveBeenCalledWith("fixture");
    expect(deps.runVerifySweep).toHaveBeenCalledWith("fixture");
  });

  it("rechecks sweep state inside the lane after an earlier repair finishes", async () => {
    const entered = gate(), finish = gate(), secondArrived = gate();
    let state = "idle", arrivals = 0;
    const deps = dependencies({
      runFix: vi.fn(async () => { entered.release(); await finish.promise; return { ok: true }; }),
      fetchRunnerState: vi.fn(async () => ({ status: state }))
    });
    const { port } = await listen(deps, () => { if (++arrivals === 2) secondArrived.release(); });
    const first = request(port, "/api/fix", fixBody);
    await entered.promise;
    const second = request(port, "/api/verify-sweep", sweepBody);
    await secondArrived.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(deps.fetchRunnerState).not.toHaveBeenCalled();
    state = "running";
    finish.release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(409);
    expect(deps.runVerifySweep).not.toHaveBeenCalled();
  });

  it("runs queued fixes sequentially so the runner can refuse a now-stale action", async () => {
    const entered = gate(), finish = gate(), secondArrived = gate();
    let valid = true, arrivals = 0;
    const deps = dependencies({ runFix: vi.fn(async () => {
      if (!valid) return { ok: false, error: "finding no longer current" };
      entered.release();
      await finish.promise;
      valid = false;
      return { ok: true };
    }) });
    const { port } = await listen(deps, () => { if (++arrivals === 2) secondArrived.release(); });
    const first = request(port, "/api/fix", fixBody);
    await entered.promise;
    const second = request(port, "/api/fix", fixBody);
    await secondArrived.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(deps.runFix).toHaveBeenCalledTimes(1);
    finish.release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(400);
    expect(deps.runFix).toHaveBeenCalledTimes(2);
  });

  it("releases the lane after a failed operation and fails closed when the app is down", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = dependencies({
      runFix: vi.fn().mockRejectedValueOnce(new Error("synthetic failure")).mockResolvedValue({ ok: true }),
      isAppUp: vi.fn(async () => false)
    });
    const { port } = await listen(deps);
    expect((await request(port, "/api/fix", fixBody)).status).toBe(500);
    expect((await request(port, "/api/fix", fixBody)).status).toBe(200);
    expect((await request(port, "/api/verify-sweep", sweepBody)).status).toBe(503);
    expect(deps.fetchRunnerState).not.toHaveBeenCalled();
    expect(deps.runVerifySweep).not.toHaveBeenCalled();
  });
});

describe("Preflight read-only surface", () => {
  it("serves the injected report and confines assets by real path", async () => {
    const deps = dependencies();
    const { port } = await listen(deps);
    expect((await request(port, "/api/report?checks=ports,drift")).status).toBe(200);
    expect(deps.buildReport).toHaveBeenCalledWith({ checks: ["ports", "drift"] });
    expect((await request(port, "/")).text).toBe("fixture view");
    expect((await request(port, "/", undefined, {}, "HEAD")).text).toBe("");
    for (const route of ["/../dist-sibling/secret.txt", "/%2e%2e/dist-sibling/secret.txt", "/escape.txt", "/missing"]) {
      const result = await request(port, route);
      expect(result.status).toBe(404);
      expect(result.text).not.toContain("outside sentinel");
    }
    expect((await request(port, "/%ZZ")).status).toBe(400);
    expect(deps.runFix).not.toHaveBeenCalled();
    expect(deps.runVerifySweep).not.toHaveBeenCalled();
  });
});

describe("Preflight status ownership", () => {
  it("keeps complete status records visible during atomic replacement and leaves no temporary files", async () => {
    const dir = path.join(root, "atomic-status");
    const statusFile = path.join(dir, "preflight.json");
    await writeStatusFile({ host: "127.0.0.1", port: 1234 }, { statusFile, pid: 101 });
    let writing = true;
    const samples: number[] = [];
    const reader = (async () => {
      while (writing) samples.push(JSON.parse(await readFile(statusFile, "utf8")).pid);
    })();
    try {
      for (let i = 0; i < 20; i++) await writeStatusFile({ host: "127.0.0.1", port: 1234 }, { statusFile, pid: i % 2 ? 101 : 202 });
    } finally { writing = false; await reader; }
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every((pid) => pid === 101 || pid === 202)).toBe(true);
    expect(await readdir(dir)).toEqual(["preflight.json"]);
  });

  it("old cleanup preserves a replacement's registration and only its owner removes it", async () => {
    const statusFile = path.join(root, "owned-status", "preflight.json");
    await writeStatusFile({ host: "127.0.0.1", port: 1234 }, { statusFile, pid: 101 });
    await writeStatusFile({ host: "127.0.0.1", port: 1235 }, { statusFile, pid: 202 });
    await clearStatusFile({ statusFile, pid: 101 });
    expect(JSON.parse(await readFile(statusFile, "utf8"))).toMatchObject({ pid: 202, port: 1235 });
    await clearStatusFile({ statusFile, pid: 202 });
    await expect(readFile(statusFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(clearStatusFile({ statusFile, pid: 202 })).resolves.toBeUndefined();
  });

  it("a bind failure preserves the incumbent record and installs no shutdown listeners", async () => {
    const { port } = await listen();
    const statusFile = path.join(root, "bind-status", "preflight.json");
    await writeStatusFile({ host: "127.0.0.1", port }, { statusFile, pid: 202 });
    const before = await readFile(statusFile, "utf8");
    const term = process.listenerCount("SIGTERM"), int = process.listenerCount("SIGINT");
    await expect(startServer({ port, host: "127.0.0.1" }, { ...dependencies(), statusFile })).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(await readFile(statusFile, "utf8")).toBe(before);
    expect(process.listenerCount("SIGTERM")).toBe(term);
    expect(process.listenerCount("SIGINT")).toBe(int);
  });

  it("records the actual bound port and releases its own record on close", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const statusFile = path.join(root, "bound-status", "preflight.json");
    const server = await startServer({ port: 0, host: "127.0.0.1" }, { ...dependencies(), statusFile });
    servers.push(server);
    const port = (server.address() as import("node:net").AddressInfo).port;
    expect(JSON.parse(await readFile(statusFile, "utf8"))).toMatchObject({ pid: process.pid, port });
    expect((await request(port, "/health")).status).toBe(200);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect.poll(async () => {
      try { await readFile(statusFile); return false; } catch { return true; }
    }).toBe(true);
  });

  it("import alone neither starts a server nor changes the selected status home", async () => {
    const home = path.join(root, "import-home");
    const statusFile = path.join(home, "ui-fittings", "preflight.json");
    await writeStatusFile({ host: "127.0.0.1", port: 1234 }, { statusFile, pid: 202 });
    const before = await readFile(statusFile, "utf8");
    const moduleUrl = pathToFileURL(path.resolve("fittings/seed/preflight/scripts/server.mjs")).href;
    const code = `const before=process.listenerCount('SIGTERM'); await import(${JSON.stringify(moduleUrl)}); console.log(process.listenerCount('SIGTERM')-before);`;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
      env: { ...process.env, GARRISON_HOME: home }, timeout: 3000, encoding: "utf8"
    });
    expect(output.trim()).toBe("0");
    expect(await readFile(statusFile, "utf8")).toBe(before);
    expect(await readdir(path.dirname(statusFile))).toEqual(["preflight.json"]);
  });
});

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
// @ts-ignore — pure .mjs
import { createIndexBuilder } from "../fittings/seed/remote-shell-runtime/lib/session-index-worker.mjs";

let root: string;
let server: http.Server | undefined;
const builders: Array<ReturnType<typeof createIndexBuilder>> = [];
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "shells-index-worker-"));
  for (const key of ["HOME", "GARRISON_HOME", "GARRISON_CLAUDE_HOME", "GARRISON_CURSOR_HOME", "CODEX_HOME", "GEMINI_CLI_HOME"]) {
    vi.stubEnv(key, path.join(root, key));
    mkdirSync(process.env[key]!, { recursive: true });
  }
  vi.stubEnv("GARRISON_REMOTESHELLRUNTIME_LOCAL_SHELLS", "false");
  vi.stubEnv("GARRISON_REMOTESHELLRUNTIME_TRANSPORTS", "{}");
});
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
  }
  await Promise.all(builders.splice(0).map(builder => builder.close()));
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it("serves health and the cached index while Cursor SQLite discovery is blocked", async () => {
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const marker = path.join(root, "sqlite-entered");
  const release = path.join(root, "sqlite-release");
  const db = path.join(root, "state.vscdb");
  writeFileSync(db, "fixture");
  vi.stubEnv("GARRISON_CURSOR_STATE_DB", db);
  vi.stubEnv("INDEX_TEST_MARKER", marker);
  vi.stubEnv("INDEX_TEST_RELEASE", release);
  vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
  writeFileSync(path.join(bin, "sqlite3"), `#!/bin/sh
: > "$INDEX_TEST_MARKER"
while [ ! -f "$INDEX_TEST_RELEASE" ]; do sleep 0.05; done
printf '%s' '${JSON.stringify([{ id: "desktop", metadata: JSON.stringify(["Saved title", "completed", null, Date.now(), null, null]) }])}'
`, { mode: 0o755 });
  vi.resetModules();
  // @ts-ignore — pure .mjs
  const { startServer } = await import("../fittings/seed/remote-shell-runtime/scripts/server.mjs");
  const started = performance.now();
  server = await startServer({ port: 0, host: "127.0.0.1", notifyFittings: [], sessionWindowDays: 5, indexPublishSeconds: 3600 });
  expect(performance.now() - started).toBeLessThan(1500);
  const base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
  try {
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 3000 });
    expect(existsSync(release)).toBe(false);
    const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
    expect(health.status).toBe(200);
    const index = await fetch(`${base}/index`, { signal: AbortSignal.timeout(1000) }).then(r => r.json());
    expect(index.updatedAt).toBeNull();
    expect(index.rows).toEqual([]);
  } finally { writeFileSync(release, "go"); }
  await vi.waitFor(async () => {
    const index = await fetch(`${base}/index`).then(r => r.json());
    expect(index.rows).toEqual(expect.arrayContaining([expect.objectContaining({ id: "desktop", title: "Saved title", status: "idle" })]));
    expect(index.updatedAt).not.toBeNull();
  }, { timeout: 5000 });
}, 15_000);

it("transfers owned-shell metadata without cloning live session handles", async () => {
  const builder = createIndexBuilder();
  builders.push(builder);
  const session = { id: "owned", transport: { name: "local", exec: () => {} }, tmuxSession: "one", runtime: "shell", state: "idle", cwd: root, label: "Owned", createdAt: new Date().toISOString(), socket: { send: () => {} } };
  const rows = await builder.build({ manager: { sessions: new Map([[session.id, session]]) }, garrisonHomeDir: process.env.GARRISON_HOME });
  expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ id: "shell:local:one", title: "Owned", status: "idle", shell: expect.objectContaining({ sessionId: "owned" }) })]));
});

it("coalesces refreshes, recovers after a timed-out worker and rejects work after close", async () => {
  const file = path.join(root, "worker.mjs");
  writeFileSync(file, 'import { parentPort } from "node:worker_threads"; parentPort.on("message", () => {});');
  const builder = createIndexBuilder({ workerUrl: pathToFileURL(file), timeoutMs: 1000 });
  builders.push(builder);
  const first = builder.build();
  expect(builder.build()).toBe(first);
  await expect(first).rejects.toThrow("timed out");
  writeFileSync(file, 'import { parentPort } from "node:worker_threads"; let n=0; parentPort.on("message", () => parentPort.postMessage({rows:[{id:++n}]}));');
  await expect(builder.build()).resolves.toEqual([{ id: 1 }]);
  await expect(builder.build()).resolves.toEqual([{ id: 2 }]);
  await builder.close();
  await expect(builder.build()).rejects.toThrow("closed");
});

it("keeps a standalone caller alive until its first discovery completes", () => {
  const runner = path.join(root, "standalone.mjs");
  const moduleUrl = pathToFileURL(path.resolve("fittings/seed/remote-shell-runtime/lib/session-index-worker.mjs")).href;
  writeFileSync(runner, `import {createIndexBuilder} from ${JSON.stringify(moduleUrl)};
const builder = createIndexBuilder();
try { console.log(JSON.stringify(await builder.build())); } finally { await builder.close(); }
`);
  expect(JSON.parse(execFileSync(process.execPath, [runner], { encoding: "utf8", timeout: 5000 }))).toEqual([]);
});

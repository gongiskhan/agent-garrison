// Omi channel fitting — M0 scaffold tests.
//
// Config layer: every pipe flag defaults OFF (invariant I9), env projection
// follows the GARRISON_OMICHANNEL_<KEY> convention, and the gateway URL is
// never a baked port literal. Server: boots on an ephemeral port under a
// sandboxed GARRISON_HOME, writes the status file, serves /health, and
// answers 501 on not-yet-implemented ingress routes.

import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_PORT,
  loadConfig,
  omiDir,
  resolveGatewayUrl,
  statusFilePath
} from "../fittings/seed/omi-channel/lib/config.mjs";
import { startServer } from "../fittings/seed/omi-channel/scripts/server.mjs";

describe("omi-channel config", () => {
  it("defaults every pipe flag to OFF with an empty env", () => {
    const cfg = loadConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.triageEnabled).toBe(false);
    expect(cfg.wakeEnabled).toBe(false);
    expect(cfg.notifyEnabled).toBe(false);
    expect(cfg.chatEnabled).toBe(false);
    expect(cfg.backfeedEnabled).toBe(false);
    expect(cfg.tipsEnabled).toBe(false);
    expect(cfg.port).toBe(DEFAULT_PORT);
    expect(cfg.bindHost).toBe("127.0.0.1");
    expect(cfg.dropDiscarded).toBe(true);
  });

  it("reads the runner-projected env convention", () => {
    const cfg = loadConfig({
      GARRISON_OMICHANNEL_PORT: "8094",
      GARRISON_OMICHANNEL_ENABLED: "true",
      GARRISON_OMICHANNEL_WAKE_VARIANTS: "gary, garry ,gérri",
      GARRISON_OMICHANNEL_ALLOWED_CATEGORIES: "work,personal",
      GARRISON_OMICHANNEL_TRIAGE_BATCH_CAP: "7",
      OMI_APP_SECRET: "s3cret"
    });
    expect(cfg.port).toBe(8094);
    expect(cfg.enabled).toBe(true);
    expect(cfg.wakeVariants).toEqual(["gary", "garry", "gérri"]);
    expect(cfg.allowedCategories).toEqual(["work", "personal"]);
    expect(cfg.triageBatchCap).toBe(7);
    expect(cfg.secrets.appSecret).toBe("s3cret");
  });

  it("never invents a gateway port literal", () => {
    expect(resolveGatewayUrl({})).toBeNull();
    expect(resolveGatewayUrl({ GARRISON_GATEWAY_URL: "http://127.0.0.1:5777/" })).toBe(
      "http://127.0.0.1:5777"
    );
    expect(resolveGatewayUrl({ GARRISON_GATEWAY_PORT: "5777" })).toBe("http://127.0.0.1:5777");
    expect(resolveGatewayUrl({ GARRISON_GATEWAY_PORT: "not-a-port" })).toBeNull();
  });

  it("resolves state and status paths under GARRISON_HOME", () => {
    const env = { GARRISON_HOME: "/tmp/gsandbox" };
    expect(omiDir(env)).toBe(path.join("/tmp/gsandbox", "omi"));
    expect(statusFilePath(env)).toBe(
      path.join("/tmp/gsandbox", "ui-fittings", "omi-channel.json")
    );
  });
});

describe("omi-channel server (sandboxed boot)", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "omi-test-home-"));
  const prevHome = process.env.GARRISON_HOME;
  process.env.GARRISON_HOME = home;
  let server: Awaited<ReturnType<typeof startServer>> | null = null;

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    if (prevHome === undefined) delete process.env.GARRISON_HOME;
    else process.env.GARRISON_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("boots, writes the status file, serves /health, and refuses ingress when disabled", async () => {
    const cfg = loadConfig({ GARRISON_HOME: home, GARRISON_OMICHANNEL_PORT: "0" });
    // loadConfig rejects 0 as a port (falls back to default); force ephemeral.
    server = await startServer({ ...cfg, port: 0 });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    expect(port).toBeGreaterThan(0);
    const base = `http://127.0.0.1:${port}`;

    const statusFile = path.join(home, "ui-fittings", "omi-channel.json");
    expect(existsSync(statusFile)).toBe(true);
    const status = JSON.parse(readFileSync(statusFile, "utf8"));
    expect(status.fittingId).toBe("omi-channel");
    expect(status.port).toBe(port);
    expect(status.pid).toBe(process.pid);

    const health = await fetch(`${base}/health`).then((r) => r.json());
    expect(health.ok).toBe(true);
    expect(health.flags).toMatchObject({
      ingress: false,
      triage: false,
      wake: false,
      notify: false,
      chat: false,
      backfeed: false
    });

    // Every pipe flag is off (I9): a funneled-but-disabled endpoint answers
    // 403 and leaks nothing, regardless of route or key.
    for (const route of ["/omi/memory", "/omi/realtime", "/omi/day-summary", "/omi/chat"]) {
      const res = await fetch(`${base}${route}?key=whatever&uid=u`, { method: "POST", body: "{}" });
      expect(res.status).toBe(403);
    }
    const manifest = await fetch(`${base}/omi/tools-manifest`);
    expect(manifest.status).toBe(403);

    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
  });
});

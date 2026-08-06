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
import {
  probeGateway,
  repairDoubleEncodedQuery,
  startServer,
  statusPage
} from "../fittings/seed/omi-channel/scripts/server.mjs";
import { OmiStore } from "../fittings/seed/omi-channel/lib/store.mjs";

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
    server = await startServer({ ...cfg, port: 0, syncJobs: false });
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
    const html = await page.text();
    expect(html).toContain('<main id="main">');
    expect(html).toContain("Channel summary");
    expect(html).toContain("values never shown");
    expect(html).toContain('<link rel="stylesheet" href="/styles.css">');

    const styles = await fetch(`${base}/styles.css`);
    expect(styles.status).toBe(200);
    expect(styles.headers.get("content-type")).toContain("text/css");
    const css = await styles.text();
    expect(css).toContain("--paper: #fbf8f1");
    expect(css).toContain("@media (max-width: 480px)");

    await fetch(`${base}/api/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "morning-briefing", title: "Morning briefing" })
    });
    const append = () => fetch(`${base}/api/threads/morning-briefing/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "assistant", text: "Briefing" }],
        suppressWebFallback: true,
        idempotencyKey: "morning:occurrence-1:omi"
      })
    }).then((response) => response.json());
    const firstAppend = await append();
    const duplicateAppend = await append();
    expect(firstAppend).toMatchObject({ ok: true, appended: 1 });
    expect(duplicateAppend).toMatchObject({ ok: true, appended: 0, deduplicated: true });
    expect(duplicateAppend.deliveryReceipts).toEqual(firstAppend.deliveryReceipts);
  });
});

describe("omi-channel thread append receipts", () => {
  it("persists one append and its completed delivery receipt per idempotency key", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "omi-thread-key-"));
    const store = new OmiStore(dir);
    store.ensureThread({ id: "morning-briefing" });
    expect(store.appendThreadMessages("morning-briefing", [{ role: "assistant", text: "Briefing" }], {
      idempotencyKey: "morning:occurrence-1:omi"
    })).toHaveLength(1);
    const receipts = [{ means: "omi-push", ok: true, target: "omi uid 1234..." }];
    store.completeThreadDelivery("morning-briefing", "morning:occurrence-1:omi", receipts);
    expect(store.appendThreadMessages("morning-briefing", [{ role: "assistant", text: "Duplicate" }], {
      idempotencyKey: "morning:occurrence-1:omi"
    })).toEqual([]);
    expect(store.threadDelivery("morning-briefing", "morning:occurrence-1:omi")).toMatchObject({
      status: "complete",
      receipts
    });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("omi-channel status page", () => {
  it("uses semantic status text, masks identity, and escapes counter content", () => {
    const cfg = loadConfig({
      GARRISON_OMICHANNEL_ENABLED: "true",
      GARRISON_GATEWAY_URL: "http://127.0.0.1:4777",
      OMI_APP_ID: "secret-app-id",
      OMI_APP_SECRET: "secret-app-secret",
      OMI_IMPORT_API_KEY: "secret-import-key",
      OMI_WEBHOOK_SECRET: "secret-webhook"
    });
    const html = statusPage(
      cfg,
      { '<img src=x onerror="bad()">': '<script>bad()</script>' },
      {
        pinnedUid: "wearer-full-secret-uid",
        gateway: {
          state: "ready",
          label: "<Ready>",
          tone: 'ok\" onclick=\"bad()' as any,
          detail: "health check passed"
        }
      }
    );

    expect(html).toContain("Omi channel pipe readiness");
    expect(html).toContain("Receiving");
    expect(html).toContain("Pinned");
    expect(html).toContain("identity masked");
    expect(html).toContain("&lt;img src=x onerror=&quot;bad()&quot;&gt;");
    expect(html).toContain("&lt;script&gt;bad()&lt;/script&gt;");
    expect(html).toContain("&lt;Ready&gt;");
    expect(html).not.toContain('onclick="bad()');
    expect(html).not.toContain('<img src=x onerror="bad()">');
    expect(html).not.toContain("wearer-full-secret-uid");
    expect(html).not.toContain("secret-app-secret");
  });

  it("distinguishes configured gateway health from URL presence", async () => {
    const cfg = loadConfig({ GARRISON_GATEWAY_URL: "http://127.0.0.1:4777/jobs" });
    const requested: string[] = [];
    const ready = await probeGateway(cfg, {
      fetchImpl: (async (input: string | URL | Request) => {
        requested.push(String(input));
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }) as typeof fetch
    });
    expect(requested).toEqual(["http://127.0.0.1:4777/health"]);
    expect(ready).toMatchObject({ state: "ready", label: "Ready" });

    const offline = await probeGateway(cfg, {
      fetchImpl: (async () => { throw new Error("connect ECONNREFUSED"); }) as typeof fetch
    });
    expect(offline).toMatchObject({ state: "offline", label: "Offline" });
    expect(statusPage(cfg)).toContain("Configured");
    expect(statusPage(cfg)).not.toContain("health check passed");
  });
});

// Regression (2026-07-30): server.mjs resolved the status file and the state
// dir from process.env instead of the config it was handed, so a test holding a
// sandboxed cfg wrote to — and on shutdown DELETED — the real
// ~/.garrison/ui-fittings/omi-channel.json of a live prod instance. That file is
// load-bearing: `down` kills by the pid in it and funnel-ensure reads the live
// port from it. The decoy home below is what the old code would have written to.
describe("omi-channel server (config paths beat process.env)", () => {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), "omi-cfgpath-"));
  const decoy = mkdtempSync(path.join(os.tmpdir(), "omi-decoy-home-"));
  const prevHome = process.env.GARRISON_HOME;
  let server: Awaited<ReturnType<typeof startServer>> | null = null;

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    if (prevHome === undefined) delete process.env.GARRISON_HOME;
    else process.env.GARRISON_HOME = prevHome;
    rmSync(sandbox, { recursive: true, force: true });
    rmSync(decoy, { recursive: true, force: true });
  });

  it("writes state and status under the cfg home, never the ambient one", async () => {
    // The two disagree on purpose: cfg says sandbox, the ambient env says decoy.
    process.env.GARRISON_HOME = decoy;
    const cfg = loadConfig({ GARRISON_HOME: sandbox });
    expect(cfg.home).toBe(sandbox);
    expect(cfg.statusFile).toBe(statusFilePath({ GARRISON_HOME: sandbox }));
    expect(cfg.stateDir).toBe(omiDir({ GARRISON_HOME: sandbox }));

    server = await startServer({ ...cfg, port: 0, syncJobs: false });

    expect(existsSync(path.join(sandbox, "ui-fittings", "omi-channel.json"))).toBe(true);
    expect(existsSync(path.join(sandbox, "omi"))).toBe(true);
    // The ambient home must be untouched — this is the actual defect.
    expect(existsSync(path.join(decoy, "ui-fittings", "omi-channel.json"))).toBe(false);
    expect(existsSync(path.join(decoy, "omi"))).toBe(false);
  });
});

// Regression (2026-07-31): a real Omi delivery arrived with the webhook URL's
// `&` percent-encoded, so `key` held the whole `secret&uid=<uid>` string (81
// chars observed vs the 48-char secret) and `uid` was absent entirely. Every
// such delivery 401s, and Omi auto-disables a dev webhook after 100 consecutive
// failures - so a phone-typed URL silently kills the pipe.
describe("omi-channel double-encoded webhook query", () => {
  const SECRET = "58ac5b50cf8a6b7955eb4b448ba1f99b193edd8f715a7d04";
  const UID = "kM7wRtH8REQhRMGpVypXXmt1jV12";

  it("splits a key that swallowed uid and session_id", () => {
    const repaired = repairDoubleEncodedQuery({
      key: `${SECRET}&uid=${UID}&session_id=abc123`
    }, null, SECRET);
    expect(repaired.key).toBe(SECRET);
    expect(repaired.uid).toBe(UID);
    expect(repaired.session_id).toBe("abc123");
  });

  it("leaves a well-formed query untouched", () => {
    const clean = { key: SECRET, uid: UID, session_id: "s1" };
    expect(repairDoubleEncodedQuery({ ...clean }, null, SECRET)).toEqual(clean);
  });


  it("recovers when the separator is NOT an ampersand (newline, space, or encoded)", () => {
    // The live failure: same 81-char length, same first/last chars, but no
    // literal '&' - so an includes("&") check missed it entirely. Prefix match
    // on the secret is separator-agnostic.
    for (const sep of ["\n", " ", "\t", "%26"]) {
      const repaired = repairDoubleEncodedQuery(
        { key: `${SECRET}${sep}uid=${UID}` },
        null,
        SECRET
      );
      expect(repaired.key).toBe(SECRET);
      expect(repaired.uid).toBe(UID);
    }
  });

  it("does not repair a key that merely resembles the secret", () => {
    const wrong = { key: `not-the-secret&uid=${UID}` };
    const repaired = repairDoubleEncodedQuery({ ...wrong }, null, SECRET);
    // Splitting on '&' still happens, but the head is NOT the secret, so auth
    // downstream rejects it - the repair never invents authorisation.
    expect(repaired.key).toBe("not-the-secret");
  });

  it("never lets a recovered value override a real query param", () => {
    // A genuine `uid` on the URL wins over one smuggled inside `key`, so this
    // can't be used to slip a different uid past the pin.
    const repaired = repairDoubleEncodedQuery({
      key: `${SECRET}&uid=attacker-uid`,
      uid: UID
    }, null, SECRET);
    expect(repaired.key).toBe(SECRET);
    expect(repaired.uid).toBe(UID);
  });
});

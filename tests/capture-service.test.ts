// Capture service fitting — M0 scaffold tests.
//
// Config layer: every pipe flag defaults OFF (invariant I9), env projection
// follows the GARRISON_CAPTURESERVICE_<KEY> convention, and the gateway URL
// is never a baked port literal. Server: boots on an ephemeral port under a
// sandboxed GARRISON_HOME, writes the status file, serves /health, answers
// 501 on not-yet-implemented capture routes, and 404 on /ack and /notify so
// the kanban fan-out treats it as not-a-sink until those milestones land.

import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_PORT,
  DEFAULT_WAKE_VARIANTS,
  loadConfig,
  captureDir,
  resolveGatewayUrl
} from "../fittings/seed/capture-service/lib/config.mjs";
import { startServer } from "../fittings/seed/capture-service/scripts/server.mjs";
import { CaptureStore, Counters, mergedCounters, ulid } from "../fittings/seed/capture-service/lib/store.mjs";

describe("capture-service config", () => {
  it("defaults every pipe flag to OFF with an empty env", () => {
    const cfg = loadConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.transcribeEnabled).toBe(false);
    expect(cfg.wakeEnabled).toBe(false);
    expect(cfg.notifyEnabled).toBe(false);
    expect(cfg.speakEnabled).toBe(false);
    expect(cfg.port).toBe(DEFAULT_PORT);
    expect(cfg.bindHost).toBe("127.0.0.1");
    expect(cfg.wakeVariants).toEqual(DEFAULT_WAKE_VARIANTS);
    expect(cfg.classifyTarget).toBe("cc-haiku-low");
    expect(cfg.apnsEnvironment).toBe("production");
  });

  it("reads the runner-projected env convention", () => {
    const cfg = loadConfig({
      GARRISON_CAPTURESERVICE_PORT: "8097",
      GARRISON_CAPTURESERVICE_ENABLED: "true",
      GARRISON_CAPTURESERVICE_STT_LANGUAGE: "pt",
      GARRISON_CAPTURESERVICE_WAKE_VARIANTS: "zeca, zeka ,zéca",
      GARRISON_CAPTURESERVICE_APNS_ENVIRONMENT: "sandbox",
      GARRISON_CAPTURESERVICE_MIN_TRANSCRIPT_WORDS: "5",
      CAPTURE_TOKEN: "tok3n",
      APNS_KEY_ID: "KEYID12345"
    });
    expect(cfg.port).toBe(8097);
    expect(cfg.enabled).toBe(true);
    expect(cfg.sttLanguage).toBe("pt");
    expect(cfg.wakeVariants).toEqual(["zeca", "zeka", "zéca"]);
    expect(cfg.apnsEnvironment).toBe("sandbox");
    expect(cfg.minTranscriptWords).toBe(5);
    expect(cfg.secrets.captureToken).toBe("tok3n");
    expect(cfg.secrets.apnsKeyId).toBe("KEYID12345");
  });

  it("never bakes a gateway port literal", () => {
    expect(resolveGatewayUrl({})).toBeNull();
    expect(resolveGatewayUrl({ GARRISON_GATEWAY_URL: "http://127.0.0.1:5777/" })).toBe(
      "http://127.0.0.1:5777"
    );
    expect(
      resolveGatewayUrl({ GARRISON_GATEWAY_HOST: "127.0.0.1", GARRISON_GATEWAY_PORT: "4777" })
    ).toBe("http://127.0.0.1:4777");
    expect(resolveGatewayUrl({ GARRISON_GATEWAY_PORT: "not-a-port" })).toBeNull();
  });

  it("resolves sandboxed state paths from the injected env, not ambient process.env", () => {
    const cfg = loadConfig({ GARRISON_HOME: "/tmp/sandbox-home" });
    expect(cfg.home).toBe("/tmp/sandbox-home");
    expect(cfg.stateDir).toBe(path.join("/tmp/sandbox-home", "capture"));
    expect(cfg.statusFile).toBe(path.join("/tmp/sandbox-home", "ui-fittings", "capture-service.json"));
    expect(captureDir({ GARRISON_CAPTURE_DIR: "/tmp/elsewhere" })).toBe("/tmp/elsewhere");
  });
});

describe("capture-service store primitives", () => {
  it("ulid is sortable and monotonic within a millisecond", () => {
    const a = ulid(1_700_000_000_000);
    const b = ulid(1_700_000_000_000);
    expect(a.length).toBe(26);
    expect(b > a).toBe(true);
  });

  it("event store round-trips and filters by status", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "capture-store-"));
    try {
      const store = new CaptureStore(dir);
      store.writeEvent({ id: "01A", source: "companion-ios", status: "pending" });
      store.writeEvent({ id: "01B", source: "companion-ios", status: "triaged" });
      expect(store.listEvents("pending").map((e: any) => e.id)).toEqual(["01A"]);
      store.updateEvent("01A", { status: "triaged" });
      expect(store.listEvents("pending")).toEqual([]);
      expect(store.listEvents().length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merges only numeric counter values across writers", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "capture-counters-"));
    try {
      new Counters(dir, "server").bump("sessions_started");
      new Counters(dir, "triage").bump("sessions_started", 2);
      const merged = mergedCounters(dir);
      expect(merged.sessions_started).toBe(3);
      expect("updatedAt" in merged).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("capture-service server", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "capture-service-"));
  let handle: Awaited<ReturnType<typeof startServer>> | null = null;

  afterAll(async () => {
    handle?.server.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("boots sandboxed, writes the status file, serves /health, and keeps milestone surfaces honest", async () => {
    const cfg = loadConfig({ GARRISON_HOME: home });
    handle = await startServer({ ...cfg, port: 0 });
    const port = handle.cfg.port;
    expect(port).toBeGreaterThan(0);
    const base = `http://127.0.0.1:${port}`;

    const statusFile = path.join(home, "ui-fittings", "capture-service.json");
    expect(existsSync(statusFile)).toBe(true);
    const status = JSON.parse(readFileSync(statusFile, "utf8"));
    expect(status.fittingId).toBe("capture-service");
    expect(status.port).toBe(port);
    expect(status.pid).toBe(process.pid);
    expect(typeof status.url).toBe("string");

    const health = await fetch(`${base}/health`).then((r) => r.json());
    expect(health.ok).toBe(true);
    expect(health.fittingId).toBe("capture-service");
    expect(health.flags).toMatchObject({
      ingress: false,
      transcribe: false,
      wake: false,
      notify: false,
      speak: false
    });
    expect(health.secrets).toMatchObject({
      deepgramApiKey: false,
      captureToken: false,
      apnsTeamId: false,
      apnsKeyId: false,
      apnsP8: false
    });
    expect(health.gatewayConfigured).toBe(false);

    // Not-yet-implemented capture surfaces answer 501 (the flag-off answer
    // becomes 403 when each milestone lands).
    for (const route of ["/capture/stream", "/capture/devices", "/capture/sessions"]) {
      const res = await fetch(`${base}${route}`, { method: "POST", body: "{}" });
      expect(res.status).toBe(501);
    }

    // NOT a sink yet: /ack and /notify must 404 so fanOutAck/fanOutNotification
    // treat this fitting as "not for you" rather than swallowing deliveries.
    for (const route of ["/ack", "/notify"]) {
      const res = await fetch(`${base}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "ack-x", text: "Created a task, test." })
      });
      expect(res.status).toBe(404);
    }

    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("capture-service");
  });
});

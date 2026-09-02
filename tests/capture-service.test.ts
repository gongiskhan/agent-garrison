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
    // The committed 8xxx-family map (D20): the node profile serves it as is,
    // sandboxes add their offset.
    expect(DEFAULT_PORT).toBe(8097);
    expect(cfg.bindHost).toBe("127.0.0.1");
    expect(cfg.ttsBackend).toBe("auto");
    expect(cfg.ttsDeepgramModel).toBe("aura-asteria-en");
    expect(cfg.sttRestLanguage).toBe(cfg.sttLanguage);
    expect(cfg.dgRestBaseUrl).toBe("https://api.deepgram.com");
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

  it("derives the Deepgram REST base from the one socket test hook, and pins the clip language separately", () => {
    const cfg = loadConfig({
      GARRISON_CAPTURESERVICE_DG_URL: "ws://127.0.0.1:4321/",
      GARRISON_CAPTURESERVICE_STT_LANGUAGE: "pt",
      GARRISON_CAPTURESERVICE_STT_REST_LANGUAGE: "en",
      GARRISON_CAPTURESERVICE_TTS_BACKEND: "Deepgram"
    });
    expect(cfg.dgBaseUrl).toBe("ws://127.0.0.1:4321/");
    expect(cfg.dgRestBaseUrl).toBe("http://127.0.0.1:4321");
    expect(loadConfig({ GARRISON_CAPTURESERVICE_DG_URL: "wss://mock.example" }).dgRestBaseUrl).toBe("https://mock.example");
    expect(cfg.sttRestLanguage).toBe("en");
    expect(cfg.ttsBackend).toBe("deepgram");
    // An unknown backend name falls back to auto instead of naming an engine that does not exist.
    expect(loadConfig({ GARRISON_CAPTURESERVICE_TTS_BACKEND: "polly" }).ttsBackend).toBe("auto");
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

  it("honours 0 for the knobs whose schema says 0 disables them", () => {
    const off = loadConfig({
      GARRISON_CAPTURESERVICE_WAKE_REVISE_AFTER_MS: "0",
      GARRISON_CAPTURESERVICE_ACTIVE_CONVERSATION_WINDOW_MS: "0",
      GARRISON_CAPTURESERVICE_TRANSCRIBE_MUTE_TIMEOUT_MS: "0",
      GARRISON_CAPTURESERVICE_WAKE_PROGRESS_INTERVAL_MS: "0"
    });
    expect(off.wakeReviseAfterMs).toBe(0);
    expect(off.activeConversationWindowMs).toBe(0);
    expect(off.transcribeMuteTimeoutMs).toBe(0);
    expect(off.wakeProgressIntervalMs).toBe(0);
    // Garbage and negatives still fall back to the defaults.
    const bad = loadConfig({
      GARRISON_CAPTURESERVICE_WAKE_REVISE_AFTER_MS: "-5",
      GARRISON_CAPTURESERVICE_ACTIVE_CONVERSATION_WINDOW_MS: "soon",
      GARRISON_CAPTURESERVICE_TRANSCRIBE_MUTE_TIMEOUT_MS: "-1",
      GARRISON_CAPTURESERVICE_WAKE_PROGRESS_INTERVAL_MS: "never"
    });
    expect(bad.wakeReviseAfterMs).toBe(600000);
    expect(bad.activeConversationWindowMs).toBe(300000);
    expect(bad.transcribeMuteTimeoutMs).toBe(120000);
    expect(bad.wakeProgressIntervalMs).toBe(60000);
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
    handle = await startServer({ ...cfg, port: 0, env: { GARRISON_HOME: home } });
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
      elevenLabsApiKey: false,
      captureToken: false,
      apnsTeamId: false,
      apnsKeyId: false,
      apnsP8: false
    });
    expect(health.gatewayConfigured).toBe(false);
    // The voice block (D20) a surface reads before showing a mic or a speaker:
    // nothing sealed, nothing enabled -> every lane honestly off. The text
    // budget is advertised regardless, so a client chunks against the number
    // the server enforces even before a key is sealed.
    expect(health.voice).toEqual({ stt: false, tts: false, ttsBackend: null, restEnabled: false, maxTextChars: 600 });
    expect(health.keyConfigured).toBe(false);

    // The voice REST lanes sit under the same master flag as every authed surface.
    for (const route of ["/stt", "/tts"]) {
      const res = await fetch(`${base}${route}`, { method: "POST", body: "x" });
      expect(res.status).toBe(403);
    }

    // M1 landed: implemented surfaces answer 403 with the master flag off
    // (nothing about routes leaks to an unauthenticated caller); a plain HTTP
    // hit on the websocket path asks for an upgrade; unrouted /capture/*
    // stays 501 until its milestone.
    const surfaces: Array<[string, RequestInit, number]> = [
      ["/capture/devices", { method: "POST", body: "{}" }, 403],
      ["/capture/sessions", {}, 403],
      ["/capture/stream", { method: "POST", body: "{}" }, 400],
      ["/capture/later-milestone", { method: "POST", body: "{}" }, 501]
    ];
    for (const [route, init, expected] of surfaces) {
      const res = await fetch(`${base}${route}`, init);
      expect(res.status).toBe(expected);
    }

    // Both sinks are live (M5/M5b): with every flag off they answer honest
    // receipts, never a silent 404 — and never pretend a delivery happened.
    const ackRes = await fetch(`${base}/ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "ack-x", text: "Created a task, test." })
    });
    expect(ackRes.status).toBe(200);
    const ackBody = await ackRes.json();
    // A routine (non-error) ack never buzzes the phone - it is spoken when a
    // session is live, else it takes the web-channel thread.
    expect(ackBody).toMatchObject({ ok: true, registered: true, delivered: "web-channel" });
    expect(ackBody.receipts[0]).toMatchObject({
      means: "companion-push",
      ok: false,
      skipped: "routine ack (web-channel only)"
    });
    expect(ackBody.receipts[1]).toMatchObject({
      means: "web-channel",
      ok: false,
      skipped: "no Conversations host: GARRISON_APP_URL unset and web channel fitting not running"
    });
    const notifyRes = await fetch(`${base}/notify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Test", text: "Created a task, test." })
    });
    expect(notifyRes.status).toBe(200);
    const notifyReceipts = await notifyRes.json();
    expect(notifyReceipts[0]).toMatchObject({ means: "companion-push", ok: false, skipped: "notify disabled" });

    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("capture-service");
  });
});

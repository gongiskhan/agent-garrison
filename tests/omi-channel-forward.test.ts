// Omi channel realtime forwarder (D24, 2026-09-02): the omi side of the one
// voice layer. Accepted realtime segments are posted to capture-service's
// POST /capture/ingest/text with a CAPTURE_TOKEN Bearer and source "omi";
// nothing is classified here. The forwarder fails closed (no token = nothing
// sent), counts every failure, never keeps a fallback, and never lets a
// segment reach a log line (I5 across the hop).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CAPTURE_FITTING_ID,
  INGEST_PATH,
  RealtimeForwarder,
  captureStatusFile,
  toCaptureSegments
} from "../fittings/seed/omi-channel/lib/forward.mjs";
import { Ingress } from "../fittings/seed/omi-channel/lib/ingress.mjs";
import { OmiStore, Counters } from "../fittings/seed/omi-channel/lib/store.mjs";
import { loadConfig } from "../fittings/seed/omi-channel/lib/config.mjs";

const TOKEN = "cap_test_token_123";
const SECRET_PHRASE = "Zeca marca uma reunião com o João para quinta";

type Hit = { headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> };

const home = mkdtempSync(path.join(os.tmpdir(), "omi-forward-"));
const hits: Hit[] = [];
let stub: Server;
let stubUrl = "";
let nextStatus = 202;

function readBody(req: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => resolve(raw));
  });
}

beforeAll(async () => {
  stub = createServer(async (req, res) => {
    const raw = await readBody(req);
    if (req.url !== INGEST_PATH || req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const body = JSON.parse(raw);
    hits.push({ headers: req.headers, body });
    if (nextStatus !== 202) {
      res.writeHead(nextStatus, { "content-type": "application/json" }).end(JSON.stringify({ error: "boom" }));
      return;
    }
    res
      .writeHead(202, { "content-type": "application/json" })
      .end(JSON.stringify({ session: body.session_id, accepted: body.segments.length }));
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const addr = stub.address();
  if (!addr || typeof addr === "string") throw new Error("stub address");
  stubUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => stub.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
});

function makeLog() {
  const lines: string[] = [];
  const log = {
    log: (m: string) => lines.push(m),
    warn: (m: string) => lines.push(m),
    error: (m: string) => lines.push(m)
  };
  return { lines, log };
}

function makeForwarder(opts: { token?: string; statusFile?: string | null; wakeEnabled?: boolean } = {}) {
  const dir = mkdtempSync(path.join(home, "case-"));
  const statusFile = opts.statusFile === undefined ? path.join(dir, `${CAPTURE_FITTING_ID}.json`) : opts.statusFile;
  if (opts.statusFile === undefined && statusFile) writeFileSync(statusFile, JSON.stringify({ url: stubUrl }));
  const cfg = {
    ...loadConfig({ GARRISON_HOME: dir, CAPTURE_TOKEN: opts.token ?? TOKEN }),
    wakeEnabled: opts.wakeEnabled ?? true
  };
  const counters = new Counters(dir, "test");
  const { lines, log } = makeLog();
  const forwarder = new RealtimeForwarder({ cfg, counters, log, statusFile });
  return { dir, cfg, counters, forwarder, lines };
}

describe("toCaptureSegments", () => {
  it("keeps the fields the ingest contract names and drops the rest", () => {
    const out = toCaptureSegments([
      { text: "  olá  ", speaker: "SPEAKER_00", speakerId: 0, is_user: true, start: 1.5, end: 2.25, junk: "x" },
      { text: "", speaker: "SPEAKER_01" },
      { text: "no extras", speaker: "", is_user: "yes", start: "1" },
      null,
      "not a segment"
    ]);
    expect(out).toEqual([
      { text: "olá", speaker: "SPEAKER_00", is_user: true, start: 1.5, end: 2.25 },
      { text: "no extras" }
    ]);
    expect(toCaptureSegments(undefined)).toEqual([]);
  });
});

describe("RealtimeForwarder", () => {
  it("posts source omi, the session id and the segments with the CAPTURE_TOKEN Bearer", async () => {
    const { counters, forwarder, lines } = makeForwarder();
    hits.length = 0;
    await forwarder.push({
      sessionId: "omi-sess-1",
      segments: [{ text: SECRET_PHRASE, speaker: "SPEAKER_00", is_user: true, start: 0, end: 2 }, { text: "" }]
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(hits[0].headers["content-type"]).toContain("application/json");
    expect(hits[0].body).toEqual({
      source: "omi",
      session_id: "omi-sess-1",
      segments: [{ text: SECRET_PHRASE, speaker: "SPEAKER_00", is_user: true, start: 0, end: 2 }]
    });
    const c = counters.read();
    expect(c.realtime_forwarded).toBe(1);
    expect(c.realtime_forward_segments).toBe(1);
    expect(c.realtime_forward_failed).toBeUndefined();
    expect(c.realtime_forward_skipped).toBeUndefined();
    expect(lines).toEqual([]);
    expect(forwarder.readiness()).toEqual({ ok: true, reason: `forwarding to ${CAPTURE_FITTING_ID}` });
  });

  it("fails closed without a CAPTURE_TOKEN: nothing sent, realtime_forward_skipped counted", async () => {
    const { counters, forwarder, lines } = makeForwarder({ token: "" });
    hits.length = 0;
    await forwarder.push({ sessionId: "s", segments: [{ text: SECRET_PHRASE }] });
    await forwarder.push({ sessionId: "s", segments: [{ text: SECRET_PHRASE }] });
    expect(hits).toHaveLength(0);
    expect(counters.read().realtime_forward_skipped).toBe(2);
    expect(counters.read().realtime_forwarded).toBeUndefined();
    expect(forwarder.readiness().ok).toBe(false);
    expect(forwarder.readiness().reason).toContain("CAPTURE_TOKEN");
    // The warning is rate limited: two pushes in the same minute, one line.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("CAPTURE_TOKEN");
  });

  it("counts realtime_forward_failed on a non-2xx and on a missing status file", async () => {
    const failing = makeForwarder();
    nextStatus = 500;
    try {
      hits.length = 0;
      await failing.forwarder.push({ sessionId: "s", segments: [{ text: SECRET_PHRASE }] });
    } finally {
      nextStatus = 202;
    }
    expect(hits).toHaveLength(1);
    expect(failing.counters.read().realtime_forward_failed).toBe(1);
    expect(failing.counters.read().realtime_forwarded).toBeUndefined();
    expect(failing.lines.some((l) => l.includes("HTTP 500"))).toBe(true);

    const noStatus = makeForwarder({ statusFile: path.join(home, "nope", `${CAPTURE_FITTING_ID}.json`) });
    await noStatus.forwarder.push({ sessionId: "s", segments: [{ text: SECRET_PHRASE }] });
    expect(noStatus.counters.read().realtime_forward_failed).toBe(1);
    expect(noStatus.forwarder.readiness()).toEqual({
      ok: false,
      reason: `${CAPTURE_FITTING_ID} not running (no status file url)`
    });
  });

  it("counts a wrong token as failed (capture-service answers 401), never as forwarded", async () => {
    const { counters, forwarder } = makeForwarder({ token: "not-the-token" });
    hits.length = 0;
    await forwarder.push({ sessionId: "s", segments: [{ text: SECRET_PHRASE }] });
    expect(hits).toHaveLength(0);
    expect(counters.read().realtime_forward_failed).toBe(1);
  });

  it("counts a connection failure as failed without throwing", async () => {
    const dir = mkdtempSync(path.join(home, "dead-"));
    const statusFile = path.join(dir, `${CAPTURE_FITTING_ID}.json`);
    // A port nothing listens on: connection refused, not a hang.
    writeFileSync(statusFile, JSON.stringify({ url: "http://127.0.0.1:1" }));
    const cfg = { ...loadConfig({ GARRISON_HOME: dir, CAPTURE_TOKEN: TOKEN }), wakeEnabled: true };
    const counters = new Counters(dir, "test");
    const { lines, log } = makeLog();
    const forwarder = new RealtimeForwarder({ cfg, counters, log, statusFile, timeoutMs: 500 });
    await expect(forwarder.push({ sessionId: "s", segments: [{ text: SECRET_PHRASE }] })).resolves.toBeUndefined();
    expect(counters.read().realtime_forward_failed).toBe(1);
    expect(lines).toHaveLength(1);
  });

  it("never writes segment text into a log line, whatever fails (I5)", async () => {
    const all: string[] = [];
    const a = makeForwarder({ token: "" });
    await a.forwarder.push({ sessionId: "s", segments: [{ text: SECRET_PHRASE }] });
    all.push(...a.lines);
    const b = makeForwarder({ statusFile: path.join(home, "nope2", "x.json") });
    await b.forwarder.push({ sessionId: "s", segments: [{ text: SECRET_PHRASE }] });
    all.push(...b.lines);
    const c = makeForwarder();
    nextStatus = 503;
    try {
      await c.forwarder.push({ sessionId: "s", segments: [{ text: SECRET_PHRASE }] });
    } finally {
      nextStatus = 202;
    }
    all.push(...c.lines);
    expect(all.length).toBeGreaterThanOrEqual(3);
    for (const line of all) {
      expect(line).not.toContain("Zeca");
      expect(line).not.toContain("João");
      expect(line).not.toContain(SECRET_PHRASE);
    }
  });

  it("readiness reports wake_enabled off first", () => {
    const { forwarder } = makeForwarder({ wakeEnabled: false });
    expect(forwarder.readiness().ok).toBe(false);
    expect(forwarder.readiness().reason).toContain("wake_enabled off");
  });

  it("discovers the voice layer from the home its config was loaded with, not process.env", async () => {
    const dir = mkdtempSync(path.join(home, "cfg-home-"));
    mkdirSync(path.join(dir, "ui-fittings"), { recursive: true });
    writeFileSync(path.join(dir, "ui-fittings", `${CAPTURE_FITTING_ID}.json`), JSON.stringify({ url: stubUrl }));
    const cfg = { ...loadConfig({ GARRISON_HOME: dir, CAPTURE_TOKEN: TOKEN }), wakeEnabled: true };
    const counters = new Counters(dir, "test");
    // No statusFile and an env that names a DIFFERENT home: only cfg.home can
    // lead to the stub.
    const other = mkdtempSync(path.join(home, "other-home-"));
    const forwarder = new RealtimeForwarder({ cfg, counters, log: makeLog().log, env: { GARRISON_HOME: other } });
    expect(captureStatusFile(cfg)).toBe(path.join(dir, "ui-fittings", `${CAPTURE_FITTING_ID}.json`));
    expect(forwarder.readiness()).toEqual({ ok: true, reason: `forwarding to ${CAPTURE_FITTING_ID}` });
    hits.length = 0;
    await forwarder.push({ sessionId: "s", segments: [{ text: "hello" }] });
    expect(hits).toHaveLength(1);
    expect(counters.read().realtime_forwarded).toBe(1);

    // A config that fell back to the real ~/.garrison inside a test runner
    // discovers nothing: sandboxed runs never reach the live voice layer.
    const real = { ...cfg, home: path.join(os.homedir(), ".garrison") };
    expect(captureStatusFile(real, { VITEST: "1" })).toBeNull();
    expect(captureStatusFile(real, {})).toBe(path.join(os.homedir(), ".garrison", "ui-fittings", `${CAPTURE_FITTING_ID}.json`));
    expect(captureStatusFile({ ...cfg, home: "" })).toBeNull();
  });

  it("readiness turns red after a rejected forward and green again once a batch lands", async () => {
    const { forwarder } = makeForwarder();
    expect(forwarder.readiness().ok).toBe(true);
    nextStatus = 401;
    try {
      await forwarder.push({ sessionId: "s", segments: [{ text: SECRET_PHRASE }] });
    } finally {
      nextStatus = 202;
    }
    const red = forwarder.readiness();
    expect(red.ok).toBe(false);
    expect(red.reason).toContain("HTTP 401");
    expect(red.reason).not.toContain(SECRET_PHRASE);
    await forwarder.push({ sessionId: "s", segments: [{ text: SECRET_PHRASE }] });
    expect(forwarder.readiness()).toEqual({ ok: true, reason: `forwarding to ${CAPTURE_FITTING_ID}` });
  });

  it("sends the batches of one session in arrival order even when an earlier one is slow", async () => {
    const dir = mkdtempSync(path.join(home, "order-"));
    const statusFile = path.join(dir, `${CAPTURE_FITTING_ID}.json`);
    writeFileSync(statusFile, JSON.stringify({ url: "http://voice.invalid" }));
    const cfg = { ...loadConfig({ GARRISON_HOME: dir, CAPTURE_TOKEN: TOKEN }), wakeEnabled: true };
    const counters = new Counters(dir, "test");
    const sent: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { session_id: string; segments: Array<{ text: string }> };
      // The first request of session "a" is held until the test lets it go;
      // everything else answers at once.
      if (calls++ === 0) await firstHeld;
      sent.push(`${body.session_id}:${body.segments[0].text}`);
      return { ok: true, status: 202 };
    }) as unknown as typeof fetch;
    const forwarder = new RealtimeForwarder({ cfg, counters, log: makeLog().log, statusFile, fetchImpl });
    // Fire-and-forget, the way ingress.mjs calls it.
    const a1 = forwarder.push({ sessionId: "a", segments: [{ text: "a-first" }] });
    const a2 = forwarder.push({ sessionId: "a", segments: [{ text: "a-second" }] });
    const b1 = forwarder.push({ sessionId: "b", segments: [{ text: "b-first" }] });
    await b1;
    // Session b is independent of a's held request and has already landed;
    // a-second must still be waiting behind a-first.
    expect(sent).toEqual(["b:b-first"]);
    releaseFirst();
    await Promise.all([a1, a2]);
    expect(sent).toEqual(["b:b-first", "a:a-first", "a:a-second"]);
    expect(counters.read().realtime_forwarded).toBe(3);
  });
});

describe("Ingress -> forwarder", () => {
  function makeIngress(wakeEnabled: boolean) {
    const dir = mkdtempSync(path.join(home, "ingress-"));
    mkdirSync(path.join(dir, "ui-fittings"), { recursive: true });
    writeFileSync(path.join(dir, "ui-fittings", `${CAPTURE_FITTING_ID}.json`), JSON.stringify({ url: stubUrl }));
    const cfg = { ...loadConfig({ GARRISON_HOME: dir, CAPTURE_TOKEN: TOKEN }), wakeEnabled };
    const store = new OmiStore(path.join(dir, "omi"));
    const counters = new Counters(store.root, "test");
    const pushes: Array<{ sessionId: string; segments: unknown[] }> = [];
    const forwarder = {
      push: async (args: { sessionId: string; segments: unknown[] }) => {
        pushes.push(args);
      },
      readiness: () => ({ ok: true, reason: "stub" })
    };
    const ingress = new Ingress({ cfg, store, counters, forwarder, log: { error: () => {}, log: () => {}, warn: () => {} } });
    return { ingress, counters, pushes, store };
  }

  it("hands every accepted realtime envelope to the forwarder with the recovered session id", () => {
    const { ingress, counters, pushes, store } = makeIngress(true);
    ingress.acceptRealtime({
      bodyText: JSON.stringify({ session_id: "sess-a", segments: [{ text: SECRET_PHRASE, speaker: "SPEAKER_00" }] }),
      sessionId: null
    });
    ingress.acceptRealtime({ bodyText: JSON.stringify([{ text: "bare array form" }]), sessionId: "sess-b" });
    expect(pushes.map((p) => p.sessionId)).toEqual(["sess-a", "sess-b"]);
    expect(pushes[0].segments).toEqual([{ text: SECRET_PHRASE, speaker: "SPEAKER_00" }]);
    const c = counters.read();
    expect(c.realtime_calls).toBe(2);
    expect(c.realtime_segments).toBe(2);
    // Realtime segments are never persisted here: the only local trace is the counters.
    expect(store.listEvents()).toEqual([]);
  });

  it("accepts the transcript_segments and data.segments envelopes with the body's session id", () => {
    // Omi is not consistent across triggers: the memory-creation payload keys
    // its segments `transcript_segments`, and some deliveries nest under `data`.
    const { ingress, counters, pushes } = makeIngress(true);
    ingress.acceptRealtime({
      bodyText: JSON.stringify({ session_id: "sess-t", transcript_segments: [{ text: SECRET_PHRASE }, { text: "two" }] }),
      sessionId: null
    });
    ingress.acceptRealtime({
      bodyText: JSON.stringify({ data: { session_id: "sess-d", segments: [{ text: "nested" }] } }),
      sessionId: null
    });
    expect(pushes.map((p) => p.sessionId)).toEqual(["sess-t", "sess-d"]);
    expect(pushes[0].segments).toHaveLength(2);
    expect(pushes[1].segments).toEqual([{ text: "nested" }]);
    const c = counters.read();
    expect(c.realtime_segments).toBe(3);
    expect(c.realtime_enveloped).toBe(2);
    expect(c.realtime_malformed).toBeUndefined();
  });

  it("counts realtime_malformed for non-JSON and unknown shapes, logging only the shape (I5)", () => {
    const dir = mkdtempSync(path.join(home, "ingress-"));
    const cfg = { ...loadConfig({ GARRISON_HOME: dir, CAPTURE_TOKEN: TOKEN }), wakeEnabled: true };
    const store = new OmiStore(path.join(dir, "omi"));
    const counters = new Counters(store.root, "test");
    const pushes: unknown[] = [];
    const warnings: string[] = [];
    const forwarder = { push: async (args: unknown) => { pushes.push(args); }, readiness: () => ({ ok: true, reason: "stub" }) };
    const ingress = new Ingress({
      cfg,
      store,
      counters,
      forwarder,
      log: { error: () => {}, log: () => {}, warn: (line: string) => { warnings.push(line); } }
    });
    ingress.acceptRealtime({ bodyText: "{not json", sessionId: "s" });
    ingress.acceptRealtime({ bodyText: JSON.stringify({ session_id: "s", utterance: SECRET_PHRASE }), sessionId: null });
    ingress.acceptRealtime({ bodyText: JSON.stringify("just a string"), sessionId: "s" });
    expect(pushes).toHaveLength(0);
    expect(counters.read().realtime_malformed).toBe(3);
    expect(counters.read().realtime_calls).toBe(3);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toMatch(/unparseable as JSON/);
    expect(warnings[1]).toContain("object keys=[session_id,utterance]");
    expect(warnings[2]).toContain("not segments: string");
    for (const line of warnings) expect(line).not.toContain(SECRET_PHRASE);
  });

  it("counts and drops when wake_enabled is off, and counts a missing session id", () => {
    const off = makeIngress(false);
    off.ingress.acceptRealtime({ bodyText: JSON.stringify([{ text: SECRET_PHRASE }]), sessionId: "s" });
    expect(off.pushes).toHaveLength(0);
    expect(off.counters.read().realtime_segments).toBe(1);

    const on = makeIngress(true);
    on.ingress.acceptRealtime({ bodyText: JSON.stringify([{ text: SECRET_PHRASE }]), sessionId: null });
    expect(on.pushes).toHaveLength(0);
    expect(on.counters.read().realtime_no_session_id).toBe(1);
  });
});

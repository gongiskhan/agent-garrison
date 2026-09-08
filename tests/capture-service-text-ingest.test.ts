// Capture service - text ingest for omi-channel (D24) and the
// active-conversation pin (D25).
//
// omi-channel forwards its realtime segments to POST /capture/ingest/text;
// this suite drives that route against a sandboxed GARRISON_HOME: the Bearer
// ladder, the 400s, the socket-less text session lifecycle (opened once per
// "<source>:<session_id>", extended on every call, closed by the idle timer
// with NO capture_event, transcript or session record behind it), the shared
// echo guard in front of everything, and a wake-word segment reaching the omi
// bus - a stub gateway records the classifier and delegate requests so the
// bus's identity (omi-wake:<session>) is observable. The pin endpoints round
// it off: GET / POST / DELETE and a pinned delegate.

import { afterEach, describe, expect, it } from "vitest";
import { createServer as createHttpServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../fittings/seed/capture-service/lib/config.mjs";
import { startServer } from "../fittings/seed/capture-service/scripts/server.mjs";

const TOKEN = "text-ingest-token";
const OMI_SESSION = "omi-sess-0001";
const COMMAND = "Zeca, send Ana the report.";

// Stub gateway: a classifier reply for the pinned lane (the request carries a
// routing pin), a delegate reply WITH a session id for the full lane. Every
// request body is recorded.
function startStubGateway() {
  const requests: any[] = [];
  const server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      requests.push({ url: req.url, body: parsed });
      res.writeHead(200, { "content-type": "application/json" });
      if (parsed.routing) {
        res.end(JSON.stringify({ reply: JSON.stringify({ intent: "delegate", request: "send Ana the report", ack: "On it." }) }));
      } else {
        res.end(JSON.stringify({ reply: "Sent the report to Ana.", session_id: "gw-omi-1" }));
      }
    });
  });
  return new Promise<{ url: string; requests: any[]; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}`, requests, close: () => server.close() });
    });
  });
}

async function waitFor(pred: () => boolean, ms = 6000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 30));
  }
  return pred();
}

type Handle = Awaited<ReturnType<typeof startServer>>;

describe("capture-service text ingest and the active-conversation pin", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  async function boot(overrides: Record<string, unknown> = {}, env: Record<string, string> = {}) {
    const home = mkdtempSync(path.join(os.tmpdir(), "capture-text-"));
    const gateway = await startStubGateway();
    const fullEnv = { GARRISON_HOME: home, CAPTURE_TOKEN: TOKEN, ...env };
    const cfg = loadConfig(fullEnv);
    const handle = await startServer({
      ...cfg,
      env: fullEnv,
      port: 0,
      enabled: true,
      wakeEnabled: true,
      gatewayUrl: gateway.url,
      wakeSilenceCloseMs: 150,
      wakeSettledCloseMs: 60,
      wakeMaxCaptureMs: 2000,
      ...overrides
    });
    cleanups.push(() => {
      handle.ingress.close();
      handle.server.close();
      gateway.close();
      rmSync(home, { recursive: true, force: true });
    });
    return { handle: handle as Handle, home, gateway, base: `http://127.0.0.1:${handle.cfg.port}` };
  }

  function post(base: string, route: string, body: unknown, token: string | null = TOKEN) {
    return fetch(`${base}${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: typeof body === "string" ? body : JSON.stringify(body)
    });
  }

  function ingest(base: string, sessionId: string, texts: string[], token: string | null = TOKEN) {
    return post(
      base,
      "/capture/ingest/text",
      { source: "omi", session_id: sessionId, segments: texts.map((text, i) => ({ text, speaker: 0, is_user: true, start: i, end: i + 1 })) },
      token
    );
  }

  it("walks the Bearer ladder on both routes", async () => {
    const { handle, base } = await boot();
    let res = await ingest(base, OMI_SESSION, ["hello"], "wrong");
    expect(res.status).toBe(401);
    res = await fetch(`${base}/capture/conversation/active`);
    expect(res.status).toBe(401);

    (handle.cfg as any).secrets.captureToken = "";
    res = await ingest(base, OMI_SESSION, ["hello"]);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "CAPTURE_TOKEN not sealed" });

    (handle.cfg as any).enabled = false;
    res = await ingest(base, OMI_SESSION, ["hello"]);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "capture ingress disabled" });
    res = await fetch(`${base}/capture/conversation/active`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(403);
    // Nothing was opened by a refused call.
    expect(handle.ingress.sessions.size).toBe(0);
    expect(handle.counters.read().text_ingest_calls ?? 0).toBe(0);
  });

  it("answers 400 for a malformed ingest body", async () => {
    const { handle, base } = await boot();
    const cases: Array<[unknown, string]> = [
      ["{not json", "invalid JSON"],
      [{ session_id: OMI_SESSION, segments: [] }, "source must be one of: omi"],
      [{ source: "slack", session_id: OMI_SESSION, segments: [] }, "source must be one of: omi"],
      [{ source: "omi", segments: [] }, "session_id is required"],
      [{ source: "omi", session_id: "has space", segments: [] }, "session_id is required"],
      [{ source: "omi", session_id: OMI_SESSION }, "segments must be an array"],
      [{ source: "omi", session_id: OMI_SESSION, segments: "x" }, "segments must be an array"]
    ];
    for (const [body, error] of cases) {
      const res = await post(base, "/capture/ingest/text", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).error).toContain(error);
    }
    expect(handle.ingress.sessions.size).toBe(0);
    expect(handle.counters.read().text_sessions_opened ?? 0).toBe(0);
  });

  it("opens one text session per source:session_id and extends it on the next call", async () => {
    const { handle, base } = await boot();
    let res = await ingest(base, OMI_SESSION, ["A seca este ano está terrível.", ""]);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ session: `omi:${OMI_SESSION}`, accepted: 1 });

    res = await ingest(base, OMI_SESSION, ["Vamos ver isso amanhã.", "E depois logo se vê."]);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ session: `omi:${OMI_SESSION}`, accepted: 2 });

    res = await ingest(base, "omi-sess-0002", ["Outra conversa."]);
    expect(await res.json()).toEqual({ session: "omi:omi-sess-0002", accepted: 1 });

    expect(handle.ingress.sessions.size).toBe(2);
    const session = handle.ingress.sessions.get(`omi:${OMI_SESSION}`) as any;
    expect(session.text).toBe(true);
    expect(session.socket).toBeNull();
    expect(session.media).toBeNull();
    expect(session.record).toMatchObject({
      id: `omi:${OMI_SESSION}`,
      source: "omi",
      mode: "omi",
      external_session_id: OMI_SESSION,
      status: "live",
      text: true,
      segments: 3,
      ended: null
    });
    expect(typeof session.record.started_at).toBe("string");

    const counters = handle.counters.read();
    expect(counters.text_ingest_calls).toBe(3);
    expect(counters.text_ingest_segments).toBe(4);
    expect(counters.text_sessions_opened).toBe(2);
    expect(counters.text_sessions_closed ?? 0).toBe(0);
    // A text session is not a microphone: never speakable, never a WS session.
    expect(handle.ackSink.speakableSession()).toBeNull();
    expect(counters.sessions_started ?? 0).toBe(0);
    // /health sees the population under its own mode.
    const health = await (await fetch(`${base}/health`)).json();
    expect(health.liveSessions).toBe(2);
    expect(health.speakable.byMode).toEqual({ omi: 2 });
    expect(health.speakable.speakableNow).toBe(0);
  });

  it("runs every segment through the shared echo guard before counting it", async () => {
    const { handle, base } = await boot();
    (handle as any).echoGuard.register({ text: "Sent the report to Ana just now." });
    const res = await ingest(base, OMI_SESSION, ["Sent the report to Ana just now.", "Obrigado, até já."]);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ session: `omi:${OMI_SESSION}`, accepted: 1 });
    const counters = handle.counters.read();
    expect(counters.realtime_echo_suppressed).toBe(1);
    expect(counters.text_ingest_segments).toBe(1);
    expect(counters.wake_hits ?? 0).toBe(0);
  });

  it("closes an idle text session without a capture_event, transcript or session record", async () => {
    // The idle window is wide relative to the sleeps on purpose: the second
    // ingest is an HTTP round trip, and a loaded machine must not be able to
    // push "inside the window" past the window (a 120/70 split flaked).
    const { handle, home, base } = await boot({ textSessionIdleMs: 600 });
    await ingest(base, OMI_SESSION, ["Hoje foi um dia comprido."]);
    expect(handle.ingress.sessions.size).toBe(1);
    // A second call inside the idle window pushes the close out.
    await new Promise((r) => setTimeout(r, 100));
    await ingest(base, OMI_SESSION, ["Mas correu bem."]);
    await new Promise((r) => setTimeout(r, 100));
    expect(handle.ingress.sessions.size).toBe(1);

    expect(await waitFor(() => handle.ingress.sessions.size === 0, 2000)).toBe(true);
    const counters = handle.counters.read();
    expect(counters.text_sessions_opened).toBe(1);
    expect(counters.text_sessions_closed).toBe(1);
    // The WS lifecycle counters never moved: this was not finalizeSession.
    expect(counters.sessions_ended ?? 0).toBe(0);
    expect(counters.sessions_timeout ?? 0).toBe(0);
    expect(counters.transcripts_stored ?? 0).toBe(0);
    // Nothing on disk under the store: no capture_event (the M4 emission is
    // what a WS session end takes), no transcript, no session record.
    const capture = path.join(home, "capture");
    for (const dir of ["events", "transcripts", "sessions"]) {
      const full = path.join(capture, dir);
      expect(existsSync(full) ? readdirSync(full) : [], dir).toEqual([]);
    }
    // The next segment for the same id opens a fresh session.
    const res = await ingest(base, OMI_SESSION, ["De novo."]);
    expect(await res.json()).toEqual({ session: `omi:${OMI_SESSION}`, accepted: 1 });
    expect(handle.counters.read().text_sessions_opened).toBe(2);
  });

  it("hands a wake-word segment to the omi bus, which delegates under omi identity", async () => {
    const { handle, home, gateway, base } = await boot();
    const res = await ingest(base, OMI_SESSION, ["Está tudo bem por aqui.", COMMAND]);
    expect(await res.json()).toEqual({ session: `omi:${OMI_SESSION}`, accepted: 2 });

    // Classifier (pinned) first, then the full delegate turn.
    await waitFor(() => gateway.requests.filter((r) => !r.body.routing).length === 1);
    const classify = gateway.requests.find((r) => r.body.routing);
    expect(classify.body.routing).toEqual({ target: "cc-haiku-low" });
    const delegate = gateway.requests.find((r) => !r.body.routing);
    expect(delegate.body.sessionId).toBe(`omi-wake:omi:${OMI_SESSION}`);
    expect(delegate.body.message).toContain("send Ana the report");

    // The wake path's own capture_event carries the omi identity (I2), and
    // it is the ONLY event: the text session itself emits none.
    await waitFor(() => existsSync(path.join(home, "capture", "events")) && readdirSync(path.join(home, "capture", "events")).length === 1);
    const eventsDir = path.join(home, "capture", "events");
    const events = readdirSync(eventsDir).map((f) => JSON.parse(readFileSync(path.join(eventsDir, f), "utf8")));
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({ source: "omi", kind: "wake_command", status: "triaged" });
    expect(events[0].provenance.omi_session_id).toBe(`omi:${OMI_SESSION}`);

    await waitFor(() => (handle.counters.read().wake_delegates_answered ?? 0) === 1);
    const counters = handle.counters.read();
    expect(counters.wake_hits).toBe(1);
    expect(counters.wake_dispatches).toBe(1);
    expect(counters.wake_delegates).toBe(1);
    // The companion and pendant buses never saw the segments.
    expect((handle.wakeBus as any).sessions.size).toBe(0);
    expect((handle.pendantWakeBus as any).sessions.size).toBe(0);
    expect((handle as any).omiWakeBus.sessions.size).toBe(1);
  });

  it("gates the omi bus on wake_enabled like the other buses", async () => {
    const { handle, gateway, base } = await boot({ wakeEnabled: false });
    const res = await ingest(base, OMI_SESSION, [COMMAND]);
    expect(await res.json()).toEqual({ session: `omi:${OMI_SESSION}`, accepted: 1 });
    await new Promise((r) => setTimeout(r, 300));
    expect(handle.counters.read().wake_hits ?? 0).toBe(0);
    expect(gateway.requests.length).toBe(0);
    // The segments were still accepted and counted: ingest is not the wake gate.
    expect(handle.counters.read().text_ingest_segments).toBe(1);
  });

  it("pins, reads and clears the active conversation", async () => {
    const { handle, base } = await boot();
    const headers = { authorization: `Bearer ${TOKEN}` };
    let res = await fetch(`${base}/capture/conversation/active`, { headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ session_id: null, until: null });

    res = await post(base, "/capture/conversation/active", { session_id: "" });
    expect(res.status).toBe(400);
    res = await post(base, "/capture/conversation/active", "{nope");
    expect(res.status).toBe(400);

    const before = Date.now();
    res = await post(base, "/capture/conversation/active", { session_id: "gw-pinned-1" });
    expect(res.status).toBe(200);
    const pinned = await res.json();
    expect(pinned.session_id).toBe("gw-pinned-1");
    const until = Date.parse(pinned.until);
    expect(until).toBeGreaterThanOrEqual(before + 300000 - 50);
    expect(until).toBeLessThanOrEqual(Date.now() + 300000 + 50);

    res = await fetch(`${base}/capture/conversation/active`, { headers });
    expect(await res.json()).toEqual(pinned);

    res = await fetch(`${base}/capture/conversation/active`, { method: "PUT", headers });
    expect(res.status).toBe(405);

    res = await fetch(`${base}/capture/conversation/active`, { method: "DELETE", headers });
    expect(res.status).toBe(204);
    res = await fetch(`${base}/capture/conversation/active`, { headers });
    expect(await res.json()).toEqual({ session_id: null, until: null });
    const counters = handle.counters.read();
    expect(counters.conversation_pinned).toBe(1);
    expect(counters.conversation_pin_cleared).toBe(1);
  });

  it("a pinned conversation is what the omi bus resumes", async () => {
    const { handle, gateway, base } = await boot();
    await post(base, "/capture/conversation/active", { session_id: "gw-pinned-2" });
    await ingest(base, OMI_SESSION, [COMMAND]);
    await waitFor(() => gateway.requests.filter((r) => !r.body.routing).length === 1);
    const delegate = gateway.requests.find((r) => !r.body.routing);
    expect(delegate.body.sessionId).toBe("gw-pinned-2");
    await waitFor(() => (handle.counters.read().wake_delegates_answered ?? 0) === 1);
    expect(handle.counters.read().wake_delegate_resumed_pin).toBe(1);
    expect(handle.counters.read().wake_delegate_resumed_window ?? 0).toBe(0);
  });
});

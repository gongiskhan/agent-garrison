// Omi channel M1 — ingress and normalization acceptance (build spec):
// replaying the full fixture set twice yields identical inbox state (I6),
// malformed payloads land in `failed` with raw preserved, wrong secret and
// foreign uid are rejected and counted (I8), webhooks ack fast with async
// normalization (I7), and realtime payloads are never persisted (I5).

import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../fittings/seed/omi-channel/lib/config.mjs";
import { startServer } from "../fittings/seed/omi-channel/scripts/server.mjs";
import { Ingress } from "../fittings/seed/omi-channel/lib/ingress.mjs";
import { OmiStore, Counters } from "../fittings/seed/omi-channel/lib/store.mjs";
import {
  normalizeConversation,
  normalizeDaySummary
} from "../fittings/seed/omi-channel/lib/normalize.mjs";
import { replayFixtures } from "../fittings/seed/omi-channel/scripts/replay.mjs";

const FIXTURES = path.resolve(__dirname, "..", "fittings", "seed", "omi-channel", "fixtures");
const SECRET = "test-webhook-secret";
const UID = "omi_test_user_1";

const home = mkdtempSync(path.join(os.tmpdir(), "omi-ingress-home-"));
const prevHome = process.env.GARRISON_HOME;
process.env.GARRISON_HOME = home;

function eventsDir() {
  return path.join(home, "omi", "events");
}

function listEventFiles() {
  return existsSync(eventsDir()) ? readdirSync(eventsDir()).sort() : [];
}

function readEvents() {
  return listEventFiles().map((f) => JSON.parse(readFileSync(path.join(eventsDir(), f), "utf8")));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!predicate()) throw new Error("waitFor timed out");
}

function testCfg(overrides: Record<string, unknown> = {}) {
  const cfg = loadConfig({ GARRISON_HOME: home });
  return {
    ...cfg,
    port: 0,
    enabled: true,
    syncJobs: false,
    secrets: { ...cfg.secrets, webhookSecret: SECRET },
    ...overrides
  };
}

describe("omi-channel ingress", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let base = "";

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    if (prevHome === undefined) delete process.env.GARRISON_HOME;
    else process.env.GARRISON_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("boots the ingress-enabled server", async () => {
    server = await startServer(testCfg());
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    base = `http://127.0.0.1:${port}`;
    expect(port).toBeGreaterThan(0);
  });

  it("rejects a wrong secret with 401 and counts it", async () => {
    const res = await fetch(`${base}/omi/memory?key=WRONG&uid=${UID}`, {
      method: "POST",
      body: "{}"
    });
    expect(res.status).toBe(401);
    const health = await fetch(`${base}/health`).then((r) => r.json());
    expect(health.counters.rejected_auth).toBeGreaterThanOrEqual(1);
    expect(listEventFiles()).toHaveLength(0);
  });

  it("replaying the full fixture set twice yields identical inbox state", async () => {
    const round1 = await replayFixtures({ base, key: SECRET, uid: UID, dir: FIXTURES });
    for (const r of round1) {
      expect(r.error).toBeNull();
      expect(r.status).toBe(200);
    }
    // conversations: basic, discarded, pt, mixed (drift shares conv_omi_0001
    // and is deduped) = 4; day summary = 1; malformed = 1 failed. Total 6.
    await waitFor(() => listEventFiles().length === 6);
    const snapshot1 = listEventFiles();
    const events1 = readEvents();

    const round2 = await replayFixtures({ base, key: SECRET, uid: UID, dir: FIXTURES });
    for (const r of round2) expect(r.status).toBe(200);
    // Wait for the queue to fully drain, then assert nothing changed except
    // the malformed payload (no id -> fingerprint dedupe catches it too).
    await waitFor(() => readdirSync(path.join(home, "omi", "raw-queue")).length === 0);
    await waitFor(() => listEventFiles().length >= 6);
    const snapshot2 = listEventFiles();

    // Malformed payloads have no conversation id; they are fingerprint-deduped
    // on replay, so the file set must be IDENTICAL across rounds.
    expect(snapshot2).toEqual(snapshot1);
    const health = await fetch(`${base}/health`).then((r) => r.json());
    expect(health.counters.events_deduped).toBeGreaterThanOrEqual(7);
    expect(health.counters.events_in).toBe(5);

    const kinds = events1.map((e) => e.kind).sort();
    expect(kinds.filter((k) => k === "conversation")).toHaveLength(5);
    expect(kinds.filter((k) => k === "day_summary")).toHaveLength(1);
  });

  it("lands malformed payloads in failed with raw preserved", async () => {
    const failed = readEvents().filter((e) => e.status === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].failure_reason).toBe("malformed JSON");
    expect(failed[0].raw_ref).toBeTruthy();
    const rawFile = path.join(home, "omi", failed[0].raw_ref);
    expect(existsSync(rawFile)).toBe(true);
    const raw = JSON.parse(readFileSync(rawFile, "utf8"));
    expect(raw.malformed).toBe(true);
    expect(raw.bodyText).toContain("conv_omi_9999");
  });

  it("pins the first authenticated uid and rejects a foreign uid with 403", async () => {
    const state = JSON.parse(readFileSync(path.join(home, "omi", "state.json"), "utf8"));
    expect(state.pinnedUid).toBe(UID);

    const res = await fetch(`${base}/omi/memory?key=${SECRET}&uid=intruder`, {
      method: "POST",
      body: "{}"
    });
    expect(res.status).toBe(403);
    const health = await fetch(`${base}/health`).then((r) => r.json());
    expect(health.counters.rejected_uid).toBeGreaterThanOrEqual(1);
  });

  it("never persists realtime payloads (I5) - counters only", async () => {
    const before = listEventFiles();
    const rawBefore = readdirSync(path.join(home, "omi", "raw")).length;
    const res = await fetch(`${base}/omi/realtime?key=${SECRET}&uid=${UID}&session_id=s1`, {
      method: "POST",
      body: JSON.stringify([{ text: "private words", speaker: "SPEAKER_00", speakerId: 0, is_user: true, start: 0, end: 1 }])
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    expect(listEventFiles()).toEqual(before);
    expect(readdirSync(path.join(home, "omi", "raw")).length).toBe(rawBefore);
    const health = await fetch(`${base}/health`).then((r) => r.json());
    expect(health.counters.realtime_calls).toBeGreaterThanOrEqual(1);
    expect(health.counters.realtime_segments).toBeGreaterThanOrEqual(1);
  });
});

describe("omi-channel ingress authorization (unit)", () => {
  it("refuses everything when the master flag is off", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "omi-auth-"));
    try {
      const store = new OmiStore(path.join(dir, "omi"));
      const counters = new Counters(store.root, "test");
      const cfg = loadConfig({});
      const ingress = new Ingress({
        cfg: { ...cfg, enabled: false, secrets: { ...cfg.secrets, webhookSecret: SECRET } },
        store,
        counters
      });
      const verdict = ingress.authorize({ key: SECRET, uid: UID });
      expect(verdict.ok).toBe(false);
      if (verdict.ok) throw new Error("unreachable");
      expect(verdict.status).toBe(403);
      expect(counters.read().rejected_disabled).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses when no webhook secret is sealed (never an open endpoint)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "omi-auth2-"));
    try {
      const store = new OmiStore(path.join(dir, "omi"));
      const counters = new Counters(store.root, "test");
      const cfg = loadConfig({});
      const ingress = new Ingress({
        cfg: { ...cfg, enabled: true, secrets: { ...cfg.secrets, webhookSecret: "" } },
        store,
        counters
      });
      const verdict = ingress.authorize({ key: "anything", uid: UID });
      expect(verdict.ok).toBe(false);
      if (verdict.ok) throw new Error("unreachable");
      expect(verdict.status).toBe(403);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("omi-channel normalization (unit)", () => {
  const receivedAt = "2026-07-30T08:00:00.000Z";

  it("maps a conversation payload to the source-agnostic capture_event", () => {
    const raw = JSON.parse(readFileSync(path.join(FIXTURES, "conversation-basic.json"), "utf8"));
    const ev = normalizeConversation({ id: "EV1", uid: UID, receivedAt, raw });
    expect(ev.kind).toBe("conversation");
    expect(ev.source).toBe("omi");
    expect(ev.occurred_at).toBe("2026-07-29T10:01:43.384323+00:00");
    const n = ev.normalized;
    if (!n) throw new Error("normalized missing");
    expect(n.title).toBe("Launch checklist sync");
    expect(n.category).toBe("work");
    expect(n.folder).toBe("Work");
    expect(n.discarded).toBe(false);
    expect(n.action_items).toHaveLength(2);
    expect(n.action_items[0]).toMatchObject({
      description: "Send the pricing page draft to Rita",
      completed: false,
      source_ref: "conv_omi_0001"
    });
    expect(n.transcript_text).toContain("Goncalo: Let's lock the launch checklist today.");
    expect(n.transcript_text).toContain("Rita: I can own the pricing page copy");
    expect(ev.provenance.omi_conversation_id).toBe("conv_omi_0001");
    expect(ev.status).toBe("pending");
  });

  it("maps a day summary via summary_json only, with a stable day key", () => {
    const raw = JSON.parse(readFileSync(path.join(FIXTURES, "day-summary.json"), "utf8"));
    const ev = normalizeDaySummary({ id: "EV2", uid: UID, receivedAt, raw });
    expect(ev.kind).toBe("day_summary");
    expect(ev.day_key).toBe("2026-07-29");
    const n = ev.normalized;
    if (!n) throw new Error("normalized missing");
    expect(n.title).toBe("Focused launch prep with two personal errands");
    expect(n.action_items[0]).toMatchObject({
      description: "Email the beta list before Friday",
      priority: "high",
      source_ref: "conv_omi_0001"
    });
    expect(n.decisions).toEqual([
      { decision: "Rita owns the pricing page copy", source_ref: "conv_omi_0001" }
    ]);
    expect(n.questions[0].question).toBe("Which payment provider goes live first?");
    expect(n.insights[0].insight).toContain("Tuesday mornings");
    expect(n.stats?.total_conversations).toBe(4);
  });
});

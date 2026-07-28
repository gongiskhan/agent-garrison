// S3b — materialized turns + post-done continuation (D8).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import http from "node:http";
import url from "node:url";

const HERE = resolve(url.fileURLToPath(import.meta.url), "..");
const FITTING = resolve(HERE, "..", "fittings", "seed", "kanban-loop");

// env sandbox BEFORE importing modules that read GARRISON_HOME at load (web-channel
// STATUS_ROOT, threads store).
const KANBAN_DIR = mkdtempSync(join(tmpdir(), "s3b-kanban-"));
const GARRISON_HOME = mkdtempSync(join(tmpdir(), "s3b-home-"));
const RUNS_DIR = mkdtempSync(join(tmpdir(), "s3b-runs-"));
process.env.GARRISON_KANBAN_DIR = KANBAN_DIR;
process.env.GARRISON_HOME = GARRISON_HOME;
process.env.GARRISON_RUNS_DIR = RUNS_DIR;
process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";

// @ts-ignore
import { makeRequestHandler } from "../fittings/seed/kanban-loop/scripts/server.mjs";
// @ts-ignore
import { seedBoard } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";
// @ts-ignore
import { saveBoard, createCard, loadCard } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore — pure .mjs
import { RoutedGateway, shouldUseEphemeralSession } from "../fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs";
// @ts-ignore — pure .mjs
import { cardsByOrigin, createAutonomousCard } from "../fittings/seed/http-gateway/scripts/lib/autonomous-cards.mjs";

// web-channel server + threads compute their dirs at MODULE LOAD from GARRISON_HOME,
// and static imports hoist above the env assignment — so load them dynamically AFTER
// the sandbox env is set (top-level await), so the thread store + telemetry stay hermetic.
// @ts-ignore
const { assembleMaterializedContext } = await import("../fittings/seed/web-channel-default/scripts/server.mjs");
// @ts-ignore
const { ensureThread, appendMessages } = await import("../fittings/seed/web-channel-default/scripts/threads.mjs");

let server: http.Server;
let base = "";

beforeAll(async () => {
  mkdirSync(join(KANBAN_DIR, "cards"), { recursive: true });
  await saveBoard(seedBoard(), KANBAN_DIR);
  server = http.createServer(makeRequestHandler({ root: KANBAN_DIR, cwd: KANBAN_DIR, gatewayUrl: "", cap: 10 }, join(FITTING, "dist")));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  // The board discovery status file (cardsByOrigin / assembleMaterializedContext read it).
  mkdirSync(join(GARRISON_HOME, "ui-fittings"), { recursive: true });
  writeFileSync(join(GARRISON_HOME, "ui-fittings", "kanban-loop.json"), JSON.stringify({ url: base }));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

async function jget(path: string) {
  const r = await fetch(base + path);
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
}

describe("board GET /cards?origin_id filter + GET /cards/:id/handoff", () => {
  it("filters the flat card list by origin_id and exposes origin_id", async () => {
    const a = await createCard(KANBAN_DIR, { list: "todo", title: "A", project: "p", originChannel: { channel: "web", threadId: "T-alpha" } });
    await createCard(KANBAN_DIR, { list: "todo", title: "B", project: "p" }); // board origin
    const filtered = await jget(`/cards?origin_id=${encodeURIComponent("web:T-alpha")}`);
    expect(filtered.status).toBe(200);
    expect(filtered.body.cards.map((c: any) => c.id)).toContain(a.id);
    expect(filtered.body.cards.every((c: any) => c.origin_id === "web:T-alpha")).toBe(true);
    const all = await jget("/cards");
    expect(all.body.cards.length).toBeGreaterThanOrEqual(2);
  });

  it("GET /cards/:id/handoff serves the packet or 404", async () => {
    const c = await createCard(KANBAN_DIR, { list: "done", title: "with handoff", project: "p" });
    expect((await jget(`/cards/${c.id}/handoff`)).status).toBe(404); // none yet
    mkdirSync(join(KANBAN_DIR, "cards", c.id), { recursive: true });
    writeFileSync(join(KANBAN_DIR, "cards", c.id, "handoff.json"), JSON.stringify({ cardId: c.id, completionSummary: "shipped it" }));
    const got = await jget(`/cards/${c.id}/handoff`);
    expect(got.status).toBe(200);
    expect(got.body.handoff.completionSummary).toBe("shipped it");
  });
});

describe("web-channel assembleMaterializedContext (bounded, deterministic, telemetry)", () => {
  it("returns null context + zero telemetry when there is no thread id", async () => {
    const { context, telemetry } = await assembleMaterializedContext(null);
    expect(context).toBeNull();
    expect(telemetry).toMatchObject({ threadId: null, assembledChars: 0, messages: 0 });
  });

  it("assembles the recent window + this thread's board cards, capped and truncated", async () => {
    const threadId = "T-assembly";
    await ensureThread({ id: threadId, title: "t" });
    // 20 messages of ~500 chars — the window is the last 12, and the cap forces truncation.
    const msgs: { role: "user" | "assistant"; text: string }[] = [];
    for (let i = 0; i < 20; i++) msgs.push({ role: i % 2 ? "assistant" : "user", text: `msg${i} ` + "x".repeat(500) });
    await appendMessages(threadId, msgs);
    // an ACTIVE card and a DONE card for this thread
    await createCard(KANBAN_DIR, { list: "implement", title: "active work", project: "p", originChannel: { channel: "web", threadId }, });
    const done = await createCard(KANBAN_DIR, { list: "done", title: "old work", project: "p", originChannel: { channel: "web", threadId } });
    mkdirSync(join(KANBAN_DIR, "cards", done.id), { recursive: true });
    writeFileSync(join(KANBAN_DIR, "cards", done.id, "handoff.json"), JSON.stringify({ cardId: done.id, completionSummary: "finished the old work cleanly" }));

    const { context, telemetry } = await assembleMaterializedContext(threadId);
    expect(context).toContain("## Recent conversation");
    expect(context).toContain("## Active cards from this thread");
    expect(context).toContain("active work");
    expect(context).toContain("## Completed cards from this thread");
    expect(context).toContain("finished the old work cleanly"); // done one-liner via handoff
    expect(context).toContain("fetch_evidence"); // pull-on-demand trailer
    // HARD CAP + deterministic truncation (oldest thread messages dropped first).
    expect(context.length).toBeLessThanOrEqual(6000);
    expect(context).not.toContain("msg0 "); // oldest window message dropped under the cap
    expect(telemetry.activeCards).toBe(1);
    expect(telemetry.doneCards).toBe(1);
    expect(telemetry.assembledChars).toBe(context.length);
    // telemetry line written to the evidence file
    const line = join(GARRISON_HOME, "web-channel", "materialized-turns.jsonl");
    // assembleMaterializedContext does not itself log; handleChat does — but assert the
    // shape is loggable (the fields the acceptance evidence needs).
    expect(telemetry).toHaveProperty("threadId", threadId);
  });
});

describe("RoutedGateway.runWebOneShot (injectable one-shot; nothing held)", () => {
  it("isolates both web conversation turns and internal Garrison turns", () => {
    expect(shouldUseEphemeralSession("web")).toBe(true);
    expect(shouldUseEphemeralSession("garrison")).toBe(true);
    expect(shouldUseEphemeralSession("kanban")).toBe(false);
    expect(shouldUseEphemeralSession(undefined)).toBe(false);
  });

  it("uses the injected oneShotFn with the operative spawn config + prefixed message", async () => {
    let captured: any = null;
    const gw = new RoutedGateway({
      config: { taskTypes: [], tiers: [] },
      operativeSpawnConfig: { compositionDir: "/tmp/comp", model: "opus", permissionMode: "bypassPermissions", claudeBinary: "claude" },
      oneShotFn: async (args: any) => {
        captured = args;
        return { reply: "one-shot answer", sessionId: null };
      },
    });
    const out = await gw.runWebOneShot({ message: "CONTEXT\n\n---\n\nhello there", model: "opus" });
    // transcriptPath is null here because the injected one-shot returned no
    // session id (S31 links transcripts only when a real session ran).
    expect(out).toEqual({ reply: "one-shot answer", sessionId: null, transcriptPath: null });
    expect(captured.cwd).toBe("/tmp/comp");
    expect(captured.model).toBe("opus");
    expect(captured.permissionMode).toBe("bypassPermissions");
    expect(captured.message).toContain("hello there");
    expect(captured.message).toContain("CONTEXT");
  });

  it("materializedStatus reports no standing conversation session", () => {
    const gw = new RoutedGateway({ config: { taskTypes: [], tiers: [] } });
    expect(gw.materializedStatus().standingConversationSessions).toBe(0);
  });
});

describe("durable thread->card lookup (heals restarts) + continuation payload", () => {
  it("cardsByOrigin returns this origin's cards; resolveThreadCard picks live vs done", async () => {
    const gw = new RoutedGateway({ config: { taskTypes: [], tiers: [] } });
    // origin with a LIVE card -> attach
    const live = await createCard(KANBAN_DIR, { list: "plan", title: "live one", project: "p", originChannel: { channel: "web", threadId: "T-live" } });
    const byOrigin = await cardsByOrigin("web:T-live");
    expect(byOrigin.some((c: any) => c.id === live.id)).toBe(true);
    const attach = await gw.resolveThreadCard("web:T-live");
    expect(attach).toMatchObject({ attach: { id: live.id } });

    // origin with only a DONE card -> continueFrom
    const done = await createCard(KANBAN_DIR, { list: "done", title: "done one", project: "p", originChannel: { channel: "web", threadId: "T-done" } });
    const cont = await gw.resolveThreadCard("web:T-done");
    expect(cont).toEqual({ continueFrom: done.id });

    // unknown origin -> null
    expect(await gw.resolveThreadCard("web:T-nope")).toBeNull();
  });

  it("createAutonomousCard carries continues into the created card", async () => {
    const predecessor = await createCard(KANBAN_DIR, { list: "done", title: "pred", project: "p" });
    const created = await createAutonomousCard({
      message: "continue the work",
      classification: { taskType: "code", tier: "T1-standard" },
      opts: { continues: predecessor.id, project: "p", targetList: "plan" },
      buildPayload: null,
      logFn: () => {}
    });
    expect(created?.id).toBeTruthy();
    const card = await loadCard(KANBAN_DIR, created.id);
    expect(card.continues).toBe(predecessor.id);
    expect(card.origin).toBe("continuation");
  });
});

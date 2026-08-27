// S3b/M7 — exact Web turns + post-done continuation.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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

// The card store is the STATE SERVICE now, not files under GARRISON_KANBAN_DIR.
// Boot one for this file and project its discovery env before anything reads a
// card; side files still live under the kanban root this file already pins.
import { setupKanbanState } from "./kanban-state-env";
let __kanbanState: Awaited<ReturnType<typeof setupKanbanState>>;
beforeAll(async () => {
  __kanbanState = await setupKanbanState();
}, 30_000);
afterAll(async () => {
  await __kanbanState?.stop();
});


// web-channel server computes its dirs at MODULE LOAD from GARRISON_HOME, and static
// imports hoist above the env assignment — load it dynamically after the sandbox is set.
// @ts-ignore
const webServerModule = await import("../fittings/seed/web-channel-default/scripts/server.mjs");
const { buildGatewayChatBody } = webServerModule;

let server: http.Server;
let base = "";

beforeAll(async () => {
  mkdirSync(join(KANBAN_DIR, "cards"), { recursive: true });
  await saveBoard(seedBoard(), KANBAN_DIR);
  server = http.createServer(makeRequestHandler({ root: KANBAN_DIR, cwd: KANBAN_DIR, gatewayUrl: "", cap: 10 }, join(FITTING, "dist")));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  // The board discovery status file used by cardsByOrigin and route options.
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

describe("web-channel exact-message gateway body", () => {
  it("has no materialized-context API and ignores thread/card/trailer-shaped context", async () => {
    const threadId = "T-no-materialization";
    const active = await createCard(KANBAN_DIR, {
      list: "implement",
      title: "active work must stay on the board",
      project: "p",
      originChannel: { channel: "web", threadId },
    });
    const done = await createCard(KANBAN_DIR, {
      list: "done",
      title: "completed work must stay on the board",
      project: "p",
      originChannel: { channel: "web", threadId },
    });
    const exactMessage = "  preserve admitted bytes?\nsecond line  ";
    const rejectedContext = [
      "## Recent conversation",
      "assistant: stale answer",
      `active card: ${active.id}`,
      `done card: ${done.id}`,
      "fetch_evidence(card_id, ref)",
    ].join("\n");

    expect(webServerModule).not.toHaveProperty("assembleMaterializedContext");
    expect(buildGatewayChatBody({ message: exactMessage, context: rejectedContext })).toEqual({
      message: exactMessage,
      channel: "web",
    });
  });
});

describe("RoutedGateway.runWebOneShot (injectable one-shot; nothing held)", () => {
  it("isolates both web conversation turns and internal Garrison turns", () => {
    expect(shouldUseEphemeralSession("web")).toBe(true);
    expect(shouldUseEphemeralSession("garrison")).toBe(true);
    expect(shouldUseEphemeralSession("kanban")).toBe(false);
    expect(shouldUseEphemeralSession(undefined)).toBe(false);
  });

  it("uses the injected oneShotFn with the operative spawn config + exact message", async () => {
    let captured: any = null;
    const gw = new RoutedGateway({
      config: { taskTypes: [], tiers: [] },
      operativeSpawnConfig: { compositionDir: "/tmp/comp", model: "opus", permissionMode: "bypassPermissions", claudeBinary: "claude" },
      oneShotFn: async (args: any) => {
        captured = args;
        return { reply: "one-shot answer", sessionId: null };
      },
    });
    const out = await gw.runWebOneShot({ message: "hello there", model: "opus" });
    // transcriptPath is null here because the injected one-shot returned no
    // session id (S31 links transcripts only when a real session ran).
    expect(out).toEqual({
      reply: "one-shot answer",
      sessionId: null,
      effortApplied: null,
      transcriptPath: null,
    });
    expect(captured.cwd).toBe("/tmp/comp");
    expect(captured.model).toBe("opus");
    expect(captured.permissionMode).toBe("bypassPermissions");
    expect(captured.message).toBe("hello there");
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

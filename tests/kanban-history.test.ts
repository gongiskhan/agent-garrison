// The frozen History view (Conversations, 2026-08-26).
//
// Three contracts:
//   1. GET /history answers with the LEGACY layout and ONLY frozen cards, and
//      the live board never sees them - the migration froze 263 records and
//      loadAllCards asks the state service for frozen:"0", so this endpoint is
//      the one door to them.
//   2. The History view renders those records under their legacy columns and
//      opens one on click.
//   3. The card modal is READ-ONLY for a frozen record: Delete and Close, and
//      nothing else. The state service is what enforces it (409 card-frozen on
//      every write but DELETE); the UI's job is to present that as an absent
//      control rather than a button that errors on press.
//
// (1) runs the real makeRequestHandler over the real state service; (2) drives
// the real component in Chromium (this repo has no jsdom - the convention is an
// esbuild bundle through Playwright, as tests/kanban-card-conversation.test.ts
// does); (3) is pinned on the source, the convention DetailSheet already uses
// in tests/kanban-panic-ui.test.ts, because the sheet is not separately
// mountable.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import http from "node:http";
import url from "node:url";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";

const HERE = resolve(url.fileURLToPath(import.meta.url), "..");
const REPO = resolve(HERE, "..");
const FITTING = resolve(REPO, "fittings", "seed", "kanban-loop");

const KANBAN_DIR = mkdtempSync(join(tmpdir(), "history-kanban-"));
const GARRISON_HOME = mkdtempSync(join(tmpdir(), "history-home-"));
process.env.GARRISON_KANBAN_DIR = KANBAN_DIR;
process.env.GARRISON_HOME = GARRISON_HOME;
process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";

// @ts-ignore — pure .mjs
import { makeRequestHandler, buildHistoryView, frozenCardSummary } from "../fittings/seed/kanban-loop/scripts/server.mjs";
// @ts-ignore — pure .mjs
import { saveBoard, boardStateClient, BOARD_SCOPE } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore — pure .mjs
import { buildBoard } from "../fittings/seed/kanban-loop/lib/resolved-model.mjs";

import { setupKanbanState, seedCard } from "./kanban-state-env";

const LEGACY_NAMESPACE = "board.layout.legacy";
const FREEZE_REASON = "conversations-migration-v1";
const FROZEN_AT = "2026-08-26T09:00:00.000Z";

// 26-char Crockford-base32 ids so the /cards/:id routes accept them
// (isValidCardId: no I, L, O or U).
const id = (tag: string) => (tag + "0".repeat(26)).slice(0, 26);

// The pre-Conversations board, trimmed: two of its duty columns plus the manual
// ends. Column order is deliberately NOT id order, so the ordering assertion
// proves the layout is being read rather than the cards being grouped.
function legacyLayout() {
  return {
    version: 9,
    lists: [
      { id: "backlog", title: "Backlog", order: 0, kind: "manual" },
      { id: "plan", title: "Plan", order: 1, kind: "agent" },
      { id: "code", title: "Code", order: 2, kind: "agent" },
      { id: "done", title: "Done", order: 3, kind: "manual", terminal: true }
    ]
  };
}

let state: Awaited<ReturnType<typeof setupKanbanState>>;
let server: http.Server;
let base = "";

beforeAll(async () => {
  state = await setupKanbanState();
  mkdirSync(join(KANBAN_DIR, "cards"), { recursive: true });
  // The LIVE board is the five-state v10 one; the legacy layout is the separate
  // document the migration copied the old board into.
  await saveBoard(buildBoard(), KANBAN_DIR);
  const client = boardStateClient();
  await client.putConfig(LEGACY_NAMESPACE, BOARD_SCOPE, legacyLayout(), { ifMatchRev: 0 });

  const frozen = (at: string) => ({ at, reason: FREEZE_REASON, by: "test" });
  // Two frozen records on one legacy column (to pin newest-first inside it),
  // one on another, one on a column the legacy layout does NOT name...
  await seedCard({ id: id("FRZA"), title: "old plan card", list: "plan", project: "garrison", updated: "2026-08-01T00:00:00.000Z", frozen: frozen(FROZEN_AT) });
  await seedCard({ id: id("FRZB"), title: "newer plan card", list: "plan", project: "ekoa", updated: "2026-08-20T00:00:00.000Z", frozen: frozen(FROZEN_AT) });
  await seedCard({ id: id("FRZC"), title: "old done card", list: "done", updated: "2026-07-01T00:00:00.000Z", frozen: frozen(FROZEN_AT) });
  await seedCard({ id: id("FRZD"), title: "orphaned record", list: "vanished-list", updated: "2026-07-02T00:00:00.000Z", frozen: frozen(FROZEN_AT) });
  // ...and one LIVE card, which must never appear in the history.
  await seedCard({ id: id("VVEA"), title: "live card", list: "todo", project: "garrison" });

  server = http.createServer(makeRequestHandler({ root: KANBAN_DIR, cwd: KANBAN_DIR, gatewayUrl: "", cap: 10 }, join(FITTING, "dist")));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  await state?.stop();
});

const get = async (path: string) => {
  const r = await fetch(base + path);
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};

describe("GET /history", () => {
  it("lays the frozen records out under the LEGACY columns, in the legacy order", async () => {
    const res = await get("/history");
    expect(res.status).toBe(200);
    expect(res.body.legacyLayout).toBe(true);
    // The four legacy columns in their own order, then the reconstructed one.
    expect(res.body.lists.map((l: any) => l.id)).toEqual(["backlog", "plan", "code", "done", "vanished-list"]);
    expect(res.body.lists.find((l: any) => l.id === "plan").title).toBe("Plan");
    // An empty legacy column still renders - the board it was is the record.
    expect(res.body.lists.find((l: any) => l.id === "code").cards).toEqual([]);
  });

  it("returns ONLY frozen cards - the live board's cards are not history", async () => {
    const history = await get("/history");
    const ids = history.body.cards.map((c: any) => c.id);
    expect(ids).toHaveLength(4);
    expect(ids).not.toContain(id("VVEA"));
    for (const card of history.body.cards) expect(card.frozen.at).toBe(FROZEN_AT);
    expect(history.body.total).toBe(4);

    // ...and the inverse: the live board carries the live card and no frozen one.
    const board = await get("/board");
    const boardIds = board.body.cards.map((c: any) => c.id);
    expect(boardIds).toContain(id("VVEA"));
    expect(boardIds).not.toContain(id("FRZA"));
  });

  it("orders a column newest-first and keeps a card whose legacy list is gone", async () => {
    const res = await get("/history");
    const plan = res.body.lists.find((l: any) => l.id === "plan");
    expect(plan.cards.map((c: any) => c.title)).toEqual(["newer plan card", "old plan card"]);
    // The orphan column is reconstructed from the card itself and marked as such,
    // so no record is silently dropped when the legacy layout does not name it.
    const orphan = res.body.lists.find((l: any) => l.id === "vanished-list");
    expect(orphan.unlisted).toBe(true);
    expect(orphan.cards.map((c: any) => c.id)).toEqual([id("FRZD")]);
  });

  it("carries the freeze marker on the card projection, so the modal reads read-only anywhere", async () => {
    const detail = await get(`/cards/${id("FRZA")}`);
    expect(detail.status).toBe(200);
    expect(detail.body.card.frozen).toEqual({ at: FROZEN_AT, reason: FREEZE_REASON, by: "test" });
    // A live card carries an explicit null, never an absent key.
    const live = await get(`/cards/${id("VVEA")}`);
    expect(live.body.card.frozen).toBeNull();
  });

  // Seeded here rather than in beforeAll: this is the one test that mutates the
  // history, and the assertions above count what beforeAll put there.
  it("refuses every write on a frozen card but DELETE (the state service's guard)", async () => {
    const doomed = id("FRZX");
    await seedCard({
      id: doomed, title: "deletable record", list: "done",
      frozen: { at: FROZEN_AT, reason: FREEZE_REASON, by: "test" }
    });
    const before = await get(`/cards/${doomed}`);
    const patched = await fetch(`${base}/cards/${doomed}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "renamed", rev: before.body.card.rev })
    });
    expect(patched.status).toBe(409);
    expect(JSON.stringify(await patched.json())).toMatch(/frozen/i);
    expect((await get(`/cards/${doomed}`)).body.card.title).toBe("deletable record");

    const deleted = await fetch(`${base}/cards/${doomed}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    const after = await get("/history");
    expect(after.body.cards.map((c: any) => c.id)).not.toContain(doomed);
    expect(after.body.total).toBe(4);
  });
});

describe("buildHistoryView (pure)", () => {
  it("answers with the cards' own list ids when there is no legacy layout", () => {
    const view = buildHistoryView(null, [
      { id: "a", title: "a", list: "plan", frozen: { at: FROZEN_AT } }
    ]);
    expect(view.lists.map((l: any) => ({ id: l.id, unlisted: l.unlisted }))).toEqual([
      { id: "plan", unlisted: true }
    ]);
    expect(view.total).toBe(1);
  });

  it("keeps the frozen list id verbatim - history is not re-migrated", () => {
    // `code` was renamed to `implement` by the v6 migration; the LIVE board's
    // reader relocates a card left on it, and history deliberately does not.
    const summary = frozenCardSummary({ id: "x", title: "t", list: "code", frozen: { at: FROZEN_AT } });
    expect(summary.list).toBe("code");
  });
});

// ── the History view, in a real browser ─────────────────────────────────────

let browser: Browser;
let page: Page;
let bundle = "";

describe("HistoryView (browser)", () => {
  beforeAll(async () => {
    const built = await build({
      stdin: {
        sourcefile: "history-entry.tsx",
        resolveDir: REPO,
        contents: `
          import * as React from "react";
          import { createRoot } from "react-dom/client";
          import { HistoryView } from "./fittings/seed/kanban-loop/ui/history-view";

          window.__opened = [];
          window.__backs = 0;
          window.__history = ${JSON.stringify({
            legacyLayout: true,
            total: 3,
            cards: [],
            lists: [
              {
                id: "plan",
                title: "Plan",
                kind: "agent",
                cards: [
                  { id: "FROZB", title: "newer plan card", project: "ekoa", scope: "project", list: "plan", status: "ok", duty: null, created: null, updated: "2026-08-20T00:00:00.000Z", frozen: { at: FROZEN_AT, reason: FREEZE_REASON, by: "test" } },
                  { id: "FROZA", title: "old plan card", project: "garrison", scope: "project", list: "plan", status: "ok", duty: null, created: null, updated: "2026-08-01T00:00:00.000Z", frozen: { at: FROZEN_AT, reason: FREEZE_REASON, by: "test" } }
                ]
              },
              { id: "code", title: "Code", kind: "agent", cards: [] },
              {
                id: "done",
                title: "Done",
                kind: "manual",
                cards: [
                  { id: "FROZC", title: "old done card", project: null, scope: "project", list: "done", status: "ok", duty: null, created: null, updated: "2026-07-01T00:00:00.000Z", frozen: { at: FROZEN_AT, reason: FREEZE_REASON, by: "test" } }
                ]
              }
            ]
          })};

          window.fetch = (input) => {
            const url = typeof input === "string" ? input : String(input && input.url ? input.url : input);
            if (url.indexOf("/history") !== -1) {
              return Promise.resolve(new Response(JSON.stringify(window.__history), {
                status: 200, headers: { "content-type": "application/json" }
              }));
            }
            return Promise.reject(new Error("unexpected fetch: " + url));
          };

          const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          let root;
          window.__mount = () => {
            if (!root) root = createRoot(document.getElementById("root"));
            root.render(React.createElement(HistoryView, {
              onBack: () => { window.__backs++; },
              onOpenCard: (cardId) => { window.__opened.push(cardId); }
            }));
            return raf2().then(raf2);
          };
        `
      },
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' }
    });
    bundle = built.outputFiles![0].text;
    browser = await chromium.launch();
  }, 120_000);

  afterAll(async () => { await browser?.close(); });

  beforeAll(async () => {
    const skin = readFileSync(join(FITTING, "ui/styles.css"), "utf8");
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    page = await context.newPage();
    await page.setContent(`<!doctype html><html><head><style>${skin}</style></head><body><div id="root"></div></body></html>`);
    await page.addScriptTag({ content: bundle });
    await page.evaluate(() => (window as any).__mount());
  }, 120_000);

  it("renders every legacy column, its count, and its frozen cards", async () => {
    await page.waitForSelector(".history-list");
    const columns = await page.$$eval(".history-list", (nodes) => nodes.map((n) => ({
      title: n.querySelector(".lname-text")?.textContent,
      count: n.querySelector(".count")?.textContent,
      cards: Array.from(n.querySelectorAll(".history-card .ct .title")).map((t) => t.textContent)
    })));
    expect(columns.map((c) => c.title)).toEqual(["Plan", "Code", "Done"]);
    expect(columns[0].count).toBe("2");
    expect(columns[0].cards).toEqual(["newer plan card", "old plan card"]);
    // An empty legacy column is still a column - the board it was is the record.
    expect(columns[1].count).toBe("0");
    expect(columns[1].cards).toEqual([]);
    expect(columns[2].cards).toEqual(["old done card"]);
  });

  it("says these are frozen pre-Conversations records and offers a way back", async () => {
    expect(await page.textContent(".history-note")).toMatch(/frozen record/i);
    expect(await page.textContent(".history-note")).toMatch(/Conversations migration/i);
    expect(await page.textContent(".history-note")).toMatch(/Read-only/i);
    expect(await page.textContent(".history-bar .btn")).toBe("Back to board");
    await page.click(".history-bar .btn");
    expect(await page.evaluate(() => (window as any).__backs)).toBe(1);
  });

  it("offers NO write control - no composer, no add-card, no drag handle", async () => {
    expect(await page.$$(".list-add-trigger")).toHaveLength(0);
    expect(await page.$$(".cl-add, textarea, input")).toHaveLength(0);
    expect(await page.$$(".gear")).toHaveLength(0);
    // The only buttons on the surface are the cards themselves and Back.
    const labels = await page.$$eval("button", (nodes) => nodes.map((n) => n.className));
    expect(labels.filter((c) => !c.includes("history-card"))).toEqual(["btn"]);
  });

  it("opens a frozen card on click", async () => {
    await page.click(".history-card");
    expect(await page.evaluate(() => (window as any).__opened)).toEqual(["FROZB"]);
  });

  it("does not scroll the page horizontally at 390px", async () => {
    const overflow = await page.evaluate(() => ({
      body: document.body.scrollWidth - document.body.clientWidth,
      // The columns scroll INSIDE their own rail, exactly as the live board does.
      rail: (document.querySelector(".history .board-scroll") as HTMLElement).scrollWidth
        > (document.querySelector(".history .board-scroll") as HTMLElement).clientWidth
    }));
    expect(overflow.body).toBeLessThanOrEqual(0);
    expect(overflow.rail).toBe(true);
  });
});

// ── the card modal, read-only for a frozen record ───────────────────────────
//
// The whole board entry, driven: History -> open a frozen record -> read what
// the sheet actually offers. DetailSheet is not separately mountable (it lives
// in the board entry), so the entry is what gets mounted, with every fetch it
// makes stubbed.

describe("the frozen card modal (browser)", () => {
  let appBrowser: Browser;
  let app: Page;
  let probe: any;

  beforeAll(async () => {
    const built = await build({
      stdin: {
        sourcefile: "board-entry.tsx",
        resolveDir: REPO,
        contents: `
          const json = (v, s = 200) => new Response(JSON.stringify(v), { status: s, headers: { "content-type": "application/json" } });
          window.__frozen = ${JSON.stringify({
            id: "FRZA00000000000000000000".slice(0, 26), title: "Wire the outpost dispatch bridge",
            project: "garrison", scope: "project", list: "plan", status: "ok", duty: "plan",
            iterations: 2, goalMode: false, rev: 7, runId: null, runDir: null, sliceId: null,
            sessionIds: [], briefPath: null, videoUrl: null, lastDispatchError: null,
            conversationId: null,
            description: "The old bridge polled the outpost WS.",
            created: "2026-05-02T00:00:00.000Z", updated: "2026-08-01T00:00:00.000Z",
            frozen: { at: FROZEN_AT, reason: FREEZE_REASON, by: "ggomes" }
          })};
          window.fetch = (input) => {
            const u = typeof input === "string" ? input : String(input && input.url ? input.url : input);
            if (u.indexOf("/history") !== -1) return Promise.resolve(json({
              legacyLayout: true, total: 1, cards: [window.__frozen],
              lists: [{ id: "plan", title: "Plan", kind: "agent", cards: [window.__frozen] }]
            }));
            if (u.indexOf("/board/runtime") !== -1) return Promise.resolve(json({ noGateway: false }));
            if (u.indexOf("/board") !== -1) return Promise.resolve(json({ version: 10, cards: [], lists: [
              { id: "todo", title: "To do", order: 0, kind: "manual", trigger: "manual", interactive: false, terminal: false, notifyOnEntry: false, validNext: [], cards: [] }
            ] }));
            if (u.indexOf("/cards/") !== -1) return Promise.resolve(json({
              card: window.__frozen,
              checklist: [{ id: "c1", text: "read the registry", done: true }],
              links: { plan: null, brief: null, gateMarkers: null, gates: [], evidenceIndex: null, evidence: [] },
              attachments: [], decisionLog: [],
              events: [{ at: "2026-08-01T00:00:00.000Z", kind: "moved", message: "moved to plan" }]
            }));
            if (u.indexOf("/host-map") !== -1) return Promise.resolve(json({ map: {} }));
            if (u.indexOf("/route-options") !== -1) return Promise.resolve(json({ targets: [] }));
            if (u.indexOf("/machines") !== -1) return Promise.resolve(json({ machines: [], defaultRuntime: null }));
            if (u.indexOf("/policy") !== -1) return Promise.resolve(json({}, 404));
            return Promise.resolve(json({}));
          };
          import("./fittings/seed/kanban-loop/ui/main");
        `
      },
      bundle: true, write: false, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' }
    });
    const skin = readFileSync(join(FITTING, "ui/styles.css"), "utf8");
    appBrowser = await chromium.launch();
    const ctx = await appBrowser.newContext({ viewport: { width: 1440, height: 1000 } });
    app = await ctx.newPage();
    await app.setContent(
      `<!doctype html><html><head><style>html,body{margin:0;height:100%}body{display:flex;flex-direction:column}${skin}</style></head>` +
      `<body><div id="root" style="display:flex;flex-direction:column;flex:1;min-height:0"></div></body></html>`
    );
    const pageErrors: string[] = [];
    app.on("pageerror", (e) => pageErrors.push(e.message));
    await app.addScriptTag({ content: built.outputFiles![0].text, type: "module" });
    await app.waitForSelector(".topbar", { timeout: 20_000 });
    await app.click('.topbar button:text-is("History")');
    await app.waitForSelector(".history-card");
    await app.click(".history-card");
    await app.waitForSelector(".sheet").catch((err) => {
      throw new Error(`${err.message}\npage errors: ${pageErrors.join(" | ") || "(none)"}`);
    });
    probe = await app.evaluate(() => {
      const sheet = document.querySelector(".sheet")!;
      return {
        frozenCallout: sheet.querySelector(".state-callout.frozen")?.textContent?.trim() ?? null,
        headerActions: !!sheet.querySelector(".detail-actions"),
        footerActions: !!sheet.querySelector(".detail-actions-footer"),
        conversation: !!sheet.querySelector(".conv-block"),
        checklistWrites: sheet.querySelectorAll(".cl-add, .cl-edit, .cl-del, .cl-text-button").length,
        attachControls: sheet.querySelectorAll(".ev-del, input[type=file]").length,
        inputs: sheet.querySelectorAll("input, textarea, select").length,
        buttons: Array.from(sheet.querySelectorAll("button")).map((b) => b.textContent!.trim()).filter(Boolean),
        close: !!sheet.querySelector(".sh-close, [aria-label='Close']"),
        // The read-only content that MUST survive.
        description: sheet.textContent!.includes("The old bridge polled the outpost WS."),
        checklistItem: sheet.textContent!.includes("read the registry")
      };
    });
  }, 180_000);

  afterAll(async () => { await appBrowser?.close(); });

  it("reaches the frozen record from the board's History control", () => {
    // Getting this far IS the assertion: the top bar offered History, the view
    // rendered the frozen record, and clicking it opened the card sheet.
    expect(probe.frozenCallout).toMatch(/Frozen history/);
    expect(probe.frozenCallout).toMatch(/read and deleted, not edited/);
  });

  it("offers Delete and Close, and no other control at all", () => {
    // "History & artifacts" is the collapsible section's own toggle, not an action.
    expect(probe.buttons).toEqual(["History & artifacts", "Delete card"]);
    expect(probe.close).toBe(true);
    expect(probe.headerActions).toBe(false);
    expect(probe.footerActions).toBe(false);
    expect(probe.inputs).toBe(0);
    expect(probe.checklistWrites).toBe(0);
    expect(probe.attachControls).toBe(0);
  });

  it("still shows what the record SAYS - an archive you cannot read is not one", () => {
    expect(probe.description).toBe(true);
    expect(probe.checklistItem).toBe(true);
  });

  it("renders no conversation block for a pre-Conversations record", () => {
    expect(probe.conversation).toBe(false);
  });
});

// Two gates the rendered sheet cannot show: the document-level paste-to-attach
// shortcut (it is an effect, not an element) and the fact that the conversation
// block, when a frozen card HAS one, gets the frozen transport rather than
// being dropped.
describe("DetailSheet read-only gate (source)", () => {
  const source = readFileSync(join(FITTING, "ui/main.tsx"), "utf8");
  const detail = source.slice(source.indexOf("function DetailSheet"), source.indexOf("// ── terminal modal"));

  it("derives read-only from the card's own freeze marker, not only from the caller", () => {
    expect(detail).toContain("const frozenAt = card.frozen?.at ?? null;");
    expect(detail).toContain("const readOnly = readOnlyProp || Boolean(frozenAt);");
  });

  it("closes the document-level paste-to-attach shortcut", () => {
    expect(detail).toContain("if (readOnlyProp || detail?.card.frozen?.at) return;");
  });

  it("hands the conversation transport the frozen flag it already accepts", () => {
    expect(detail).toContain("frozen={readOnly}");
    expect(detail).toContain("{conversationId && (");
  });
});

describe("the five-state board is fixed", () => {
  const source = readFileSync(join(FITTING, "ui/main.tsx"), "utf8");
  const client = readFileSync(join(FITTING, "ui/api.ts"), "utf8");

  it("offers no Add-list affordance - POST /lists answers 410", () => {
    expect(source).not.toContain("add-list");
    expect(source).not.toContain("AddListSheet");
    expect(source).not.toContain("addlist");
    expect(client).not.toContain("createList");
  });

  it("keeps the per-list Add CARD affordance, which is a different control", () => {
    expect(source).toContain('className="list-add-trigger"');
    expect(source).toContain("function ListAddCard");
  });
});

// A card the board did not mint must still be deletable.
//
// The board's card ids are ULIDs, and the router used to demand one on every
// /cards/:id route. But the board does not mint every card it holds: the store is
// the mesh's state service, and a peer node, an external harness, or an older
// schema can put a row on the board under an id this server would never have
// generated. Such a card rendered on the board and then refused every call about
// itself with "invalid card id" - including DELETE, which made it permanent.
//
// The guard is now two tiers, and this file pins both: a safe single path segment
// is enough to READ or DELETE a card, while every route that starts work or writes
// lifecycle state still demands a real ULID. Traversal stays refused at both tiers.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import http from "node:http";
import url from "node:url";

const HERE = resolve(url.fileURLToPath(import.meta.url), "..");
const FITTING = resolve(HERE, "..", "fittings", "seed", "kanban-loop");

const KANBAN_DIR = mkdtempSync(join(tmpdir(), "foreignid-kanban-"));
const GARRISON_HOME = mkdtempSync(join(tmpdir(), "foreignid-home-"));
const RUNS_DIR = mkdtempSync(join(tmpdir(), "foreignid-runs-"));
process.env.GARRISON_KANBAN_DIR = KANBAN_DIR;
process.env.GARRISON_HOME = GARRISON_HOME;
process.env.GARRISON_RUNS_DIR = RUNS_DIR;
process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";

// @ts-ignore - pure ESM .mjs, no .d.ts
import { makeRequestHandler } from "../fittings/seed/kanban-loop/scripts/server.mjs";
// @ts-ignore
import { seedBoard } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";
// @ts-ignore
import { saveBoard } from "../fittings/seed/kanban-loop/lib/board.mjs";

import { setupKanbanState, seedCard } from "./kanban-state-env";

// The id the live board actually got stuck with: a benchmark harness minted its
// own, and the card could not be removed by any means the UI offers.
const FOREIGN_ID = "benchgar-1787960061";
const ULID_ID = "01KVX7G59RE5B12BZ1T3GHXVYF";

let state: Awaited<ReturnType<typeof setupKanbanState>>;
let server: http.Server;
let port = 0;

// Raw request, so an encoded traversal segment reaches the router still encoded
// (a %2F must not be normalised into a path separator on the way in).
function raw(method: string, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolveReq, rejectReq) => {
    const req = http.request({ host: "127.0.0.1", port, method, path }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { text += c; });
      res.on("end", () => {
        let body: any = text;
        try { body = JSON.parse(text); } catch { /* non-JSON body stays a string */ }
        resolveReq({ status: res.statusCode ?? 0, body });
      });
    });
    req.on("error", rejectReq);
    req.end();
  });
}

beforeAll(async () => {
  state = await setupKanbanState();
  mkdirSync(join(KANBAN_DIR, "cards"), { recursive: true });
  await saveBoard(seedBoard(), KANBAN_DIR);
  server = http.createServer(makeRequestHandler({ root: KANBAN_DIR, cwd: KANBAN_DIR, cap: 10 }, join(FITTING, "dist")));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as any).port;
  await seedCard({ id: FOREIGN_ID, list: "todo", title: "Build a small todo REST API", status: "ok" });
  await seedCard({ id: ULID_ID, list: "todo", title: "a card the board minted", status: "ok" });
}, 30_000);

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  await state?.stop();
});

describe("a card the board did not mint", () => {
  it("shows up on the board", async () => {
    const view = await raw("GET", "/board");
    expect(view.status).toBe(200);
    expect(view.body.cards.map((c: any) => c.id)).toContain(FOREIGN_ID);
  });

  it("can be read, so the card modal opens instead of erroring", async () => {
    const got = await raw("GET", `/cards/${FOREIGN_ID}`);
    expect(got.status).toBe(200);
    expect(got.body.card.title).toBe("Build a small todo REST API");
  });

  it("still cannot start work or take a lifecycle write - those need a real ULID", async () => {
    for (const [method, path] of [
      ["POST", `/cards/${FOREIGN_ID}/start`],
      ["POST", `/cards/${FOREIGN_ID}/steer`],
      ["POST", `/cards/${FOREIGN_ID}/abandon`],
      ["PATCH", `/cards/${FOREIGN_ID}`]
    ] as const) {
      const res = await raw(method, path);
      expect(res.status, `${method} ${path}`).toBe(400);
      expect(res.body.error).toBe("invalid card id");
    }
  });

  it("CAN be deleted, and leaves the board", async () => {
    const del = await raw("DELETE", `/cards/${FOREIGN_ID}`);
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);
    expect(del.body.deleted).toBe(FOREIGN_ID);

    const view = await raw("GET", "/board");
    expect(view.body.cards.map((c: any) => c.id)).not.toContain(FOREIGN_ID);
    // the card the board did mint is untouched
    expect(view.body.cards.map((c: any) => c.id)).toContain(ULID_ID);
  });
});

describe("traversal is refused at both tiers", () => {
  it("rejects an encoded traversal id on read and on delete", async () => {
    const encoded = encodeURIComponent("../../etc/passwd");
    for (const method of ["GET", "DELETE"] as const) {
      const res = await raw(method, `/cards/${encoded}`);
      expect(res.status, `${method} traversal`).toBe(400);
      expect(res.body.error).toBe("invalid card id");
    }
  });

  it("rejects a dotted or separator-bearing id even though it is not a ULID either", async () => {
    for (const bad of ["a.b", "..", ".hidden", encodeURIComponent("a/b")]) {
      const res = await raw("DELETE", `/cards/${bad}`);
      expect(res.status, `DELETE ${bad}`).toBe(400);
    }
  });
});

// The kanban suite's handle on the state service.
//
// board.mjs no longer owns a card store — the state service does — so every
// test that exercises board storage needs a service to talk to. This boots the
// REAL one on an ephemeral port against a temp DB and projects the discovery
// env (GARRISON_STATE_URL / _TOKEN / GARRISON_NODE_NAME) that board.mjs and any
// subprocess it spawns resolve through.
//
// board.mjs memoises its client on exactly those three values, so a second test
// file pointing at its own service is picked up without a module reload — and
// with all three unset the client THROWS rather than guessing, which is what
// stops a test silently hitting the real service.
//
// Side files (brief.md, attachments/, log-N.md) still live under
// GARRISON_KANBAN_DIR, so the tests that pin it keep pinning it.

import { createRequire } from "node:module";
import path from "node:path";
import url from "node:url";
import { startStateService } from "./state-service-harness";
import { StateClient } from "@garrison/state-client";

const HERE = path.resolve(url.fileURLToPath(import.meta.url), "..");

// The reset below empties tables rather than deleting cards through the API,
// because a deleted card leaves a tombstone the store will never resurrect —
// and the fixtures in this suite reuse fixed ULIDs across tests on purpose.
// A second connection is safe: the DB is WAL with a busy timeout, and the
// service is the only other writer.
function openStateDb(dbPath: string) {
  const requireFromService = createRequire(path.join(HERE, "..", "services", "state", "package.json"));
  const Database = requireFromService("better-sqlite3");
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 5000");
  return db;
}

// Ordered so a row never goes before the row that references it. Config docs
// are deliberately NOT here: the board layout is seeded once per file (often in
// beforeAll) and wiping it would leave every later test with no board.
const RESET_TABLES = [
  "notifications", "events", "origins",
  "card_docs", "card_attachments", "cards",
  "leases", "changes"
];

export interface KanbanState {
  client: StateClient;
  url: string;
  token: string;
  node: string;
  dbPath: string;
  /** Drop every card, so tests inside one file do not see each other's board.
   *  Cheap enough for a beforeEach; ULIDs never collide, so the tombstones a
   *  delete leaves behind can never block a later create. */
  reset(): Promise<void>;
  stop(): Promise<void>;
}

export async function setupKanbanState(options: { node?: string } = {}): Promise<KanbanState> {
  const node = options.node ?? "test-node";
  const harness = await startStateService({ nodes: [node] });

  process.env.GARRISON_STATE_URL = harness.url;
  process.env.GARRISON_STATE_TOKEN = harness.token;
  process.env.GARRISON_NODE_NAME = node;

  return {
    client: harness.client,
    url: harness.url,
    token: harness.token,
    node,
    dbPath: harness.dbPath,
    reset() {
      const db = openStateDb(harness.dbPath);
      try {
        db.exec(RESET_TABLES.map((t) => `DELETE FROM ${t};`).join(" "));
      } finally {
        db.close();
      }
      return Promise.resolve();
    },
    async stop() {
      delete process.env.GARRISON_STATE_URL;
      delete process.env.GARRISON_STATE_TOKEN;
      delete process.env.GARRISON_NODE_NAME;
      await harness.stop();
    }
  };
}

/** A client on the service this file booted. Throws when it did not boot one,
 *  which is the same loud failure board.mjs gives. */
export function stateClientForTests(): StateClient {
  const url = process.env.GARRISON_STATE_URL;
  const token = process.env.GARRISON_STATE_TOKEN;
  if (!url || !token) throw new Error("setupKanbanState() has not run for this test file");
  return new StateClient({ url, token, node: process.env.GARRISON_NODE_NAME ?? null });
}

/** Drop a fully-formed card straight into the store — the fixture equivalent of
 *  the `atomicWriteJSON(cards/<id>/card.json, card)` these tests used to do.
 *  `host` placement is rewritten to this node's name exactly as board.mjs does
 *  on every write (the store rejects "host" outright), and the position is
 *  allocated at the bottom of the list unless the fixture pins one. */
export async function seedCard(card: Record<string, any>): Promise<Record<string, any>> {
  const client = stateClientForTests();
  const payload: Record<string, any> = { ...card };
  if (payload.placement?.target === "host") {
    payload.placement = { ...payload.placement, target: process.env.GARRISON_NODE_NAME };
  }
  const existing = await client.getCard(String(card.id));
  if (existing) return client.patchCard(String(card.id), payload, { ifMatchRev: existing.rev });
  const position =
    typeof payload.position === "number" && Number.isFinite(payload.position) ? payload.position : "bottom";
  return client.createCard({ ...payload, position } as any);
}

/** Put a board layout document in place — the fixture equivalent of writing
 *  board.json. */
export async function seedBoardLayout(board: unknown): Promise<void> {
  const client = stateClientForTests();
  const doc = await client.getConfig("board.layout", "global");
  await client.putConfig("board.layout", "global", board, { ifMatchRev: doc?.rev ?? 0 });
}

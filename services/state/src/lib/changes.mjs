// The change feed — the mesh's ordering spine. Every mutation appends a row
// inside the same transaction; each node runs exactly one long-poll on
// GET /v1/changes?since=<seq> and fans out locally.

import { EventEmitter } from "node:events";

export const changeBus = new EventEmitter();
changeBus.setMaxListeners(64);

export function appendChange(db, { entity, entityId, op, node, summary = {} }) {
  db.prepare(
    "INSERT INTO changes(at, entity, entity_id, op, node, summary_json) VALUES (?,?,?,?,?,?)"
  ).run(new Date().toISOString(), entity, String(entityId), op, node, JSON.stringify(summary));
}

// Call AFTER the transaction commits, so long-pollers never observe a seq they
// cannot yet read.
export function signalChange() {
  changeBus.emit("change");
}

export function readChanges(db, since, limit = 500) {
  const rows = db
    .prepare("SELECT seq, at, entity, entity_id, op, node, summary_json FROM changes WHERE seq > ? ORDER BY seq LIMIT ?")
    .all(since, limit);
  return rows.map((r) => ({
    seq: r.seq,
    at: r.at,
    entity: r.entity,
    entityId: r.entity_id,
    op: r.op,
    node: r.node,
    summary: JSON.parse(r.summary_json)
  }));
}

export function maxSeq(db) {
  const row = db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM changes").get();
  return row.m;
}

export function minSeq(db) {
  const row = db.prepare("SELECT COALESCE(MIN(seq), 0) AS m FROM changes").get();
  return row.m;
}

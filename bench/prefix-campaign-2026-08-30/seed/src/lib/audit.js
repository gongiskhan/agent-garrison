// Every state change in this service leaves a row here.
//
// Call record() from the code that performs the change, inside the same
// transaction where there is one, so the audit row and the change it describes
// commit or roll back together.

import { openDb } from "./store.js";
import { mintKey } from "./identity.js";

export function record(action, detail) {
  const db = openDb();
  db.prepare("INSERT INTO audit (id, action, detail, created_at) VALUES (?, ?, ?, ?)").run(
    mintKey(),
    action,
    detail === undefined || detail === null ? null : JSON.stringify(detail),
    new Date().toISOString()
  );
}

export function recent(limit = 50) {
  return openDb().prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?").all(limit);
}

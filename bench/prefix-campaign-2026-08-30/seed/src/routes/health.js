// A route module exports register(app). server.js calls it; routes never touch
// the express instance any other way.

import { openDb } from "../lib/store.js";

export function register(app) {
  app.get("/api/health", (req, res) => {
    openDb().prepare("SELECT 1").get();
    res.json({ ok: true });
  });
}

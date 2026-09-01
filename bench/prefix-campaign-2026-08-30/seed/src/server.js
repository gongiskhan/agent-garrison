import express from "express";
import { load } from "./lib/settings.js";
import { openDb } from "./lib/store.js";
import { register as registerHealth } from "./routes/health.js";

export function createApp() {
  const app = express();
  app.use(express.json());
  registerHealth(app);
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { port } = load();
  openDb();
  createApp().listen(port, () => {
    console.log(`listening on http://localhost:${port}`);
  });
}

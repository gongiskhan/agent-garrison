import { describe, it, expect, afterAll } from "vitest";
import { createApp } from "../src/server.js";
import { closeDb } from "../src/lib/store.js";

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

describe("health", () => {
  afterAll(() => closeDb());

  it("answers ok", async () => {
    const server = await listen(createApp());
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    server.close();
  });
});

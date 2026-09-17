import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StateClient } from "@garrison/state-client";
import { startStateService } from "./state-service-harness";

let harness: Awaited<ReturnType<typeof startStateService>>;
beforeAll(async () => { harness = await startStateService({ nodes: ["old-client", "new-client", "too-old", "future-client"] }); });
afterAll(async () => { await harness?.stop(); });
const client = (node: string) => new StateClient({ url: harness.url, token: harness.tokens[node], node });

describe("Messages additive schema rollout", () => {
  it.each([["old-client", 2], ["new-client", 3]])("keeps %s writable during a sequential rollout", async (node, maxSchema) => {
    const connection = client(String(node));
    expect(await connection.hello({ minSchema: 1, maxSchema: Number(maxSchema) })).toMatchObject({ schemaVersion: 3, minCompatibleSchema: 2, behind: false });
    await connection.putConfig("fixture.rollout", `node:${node}`, { retained: true }, { ifMatchRev: 0 });
    expect((await connection.getConfig("fixture.rollout", `node:${node}`))?.body).toEqual({ retained: true });
  });
  it.each([["too-old", 1, 1], ["future-client", 4, 5]])("still refuses incompatible writes from %s", async (node, minSchema, maxSchema) => {
    const connection = client(String(node));
    expect(await connection.hello({ minSchema: Number(minSchema), maxSchema: Number(maxSchema) })).toMatchObject({ behind: true });
    await expect(connection.putConfig("fixture.rollout", `node:${node}`, { refused: true }, { ifMatchRev: 0 })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("node-behind") });
    expect(await connection.listNodes()).toBeInstanceOf(Array);
  });
});

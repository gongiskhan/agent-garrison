// Frozen history (Conversations migration): a frozen card is read-only in the
// STATE STORE — every write door refuses except DELETE and the single-key
// {frozen} escape the migration itself uses. The frozen filter hides history
// from every board-facing list.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { StateClient, StateApiError } from "@garrison/state-client";
import { startStateService } from "./state-service-harness";

let h: Awaited<ReturnType<typeof startStateService>>;
let client: StateClient;

const LIVE = "01FROZENTESTLIVEAAAAAAAAAA";
const FROZ = "01FROZENTESTFROZAAAAAAAAAA";

beforeAll(async () => {
  h = await startStateService({ nodes: ["alpha"] });
  client = h.client;
  await client.hello({ clientVersion: "test", localTime: new Date().toISOString() });
  await client.createCard({ id: LIVE, list: "todo", title: "live", status: "ok" });
  await client.createCard({ id: FROZ, list: "done", title: "old", status: "ok" });
}, 30_000);

afterAll(async () => {
  await h?.stop();
});

describe("frozen cards", () => {
  it("the single-key {frozen} patch is allowed and freezes the card", async () => {
    const frozen = await client.patchCard(
      FROZ,
      { frozen: { at: new Date().toISOString(), reason: "conversations-migration-v1", by: "alpha" } },
      { ifMatchRev: 0 }
    );
    expect(frozen.frozen.reason).toBe("conversations-migration-v1");
  });

  it("any other patch on a frozen card is 409 card-frozen — BEFORE the rev check", async () => {
    const err = await client.patchCard(FROZ, { title: "rewrite history" }, { ifMatchRev: 999 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StateApiError);
    expect((err as StateApiError).status).toBe(409);
    // frozen answers "frozen", not the misleading "conflict" a stale rev would produce
    expect((err as StateApiError).body?.error ?? (err as StateApiError).message).toMatch(/frozen/i);
  });

  it("a mixed patch that includes frozen among other keys is still refused", async () => {
    const err = await client
      .patchCard(FROZ, { frozen: null, title: "sneak" }, { ifMatchRev: 1 })
      .catch((e: unknown) => e);
    expect((err as StateApiError).status).toBe(409);
  });

  it("card docs and attachments refuse on a frozen card", async () => {
    const docErr = await client.putCardDoc(FROZ, "brief.md", "new brief").catch((e: unknown) => e);
    expect((docErr as StateApiError).status).toBe(409);
    const attErr = await client
      .putCardAttachment(FROZ, "shot.png", { bytes: 10, sha256: "aa" })
      .catch((e: unknown) => e);
    expect((attErr as StateApiError).status).toBe(409);
    // live card still accepts both
    await client.putCardDoc(LIVE, "brief.md", "fine");
  });

  it("frozen filter: '0' hides history, '1' shows only history, default shows all", async () => {
    const all = await client.listCards({});
    expect(all.map((c: any) => c.id)).toEqual(expect.arrayContaining([LIVE, FROZ]));
    const live = await client.listCards({ frozen: "0" });
    expect(live.map((c: any) => c.id)).toContain(LIVE);
    expect(live.map((c: any) => c.id)).not.toContain(FROZ);
    const hist = await client.listCards({ frozen: "1" });
    expect(hist.map((c: any) => c.id)).toEqual([FROZ]);
  });

  it("unfreeze via the single-key escape restores writability (rollback path)", async () => {
    const card = await client.getCard(FROZ);
    const thawed = await client.patchCard(FROZ, { frozen: null }, { ifMatchRev: card.rev });
    expect(thawed.frozen ?? null).toBeNull();
    const renamed = await client.patchCard(FROZ, { title: "writable again" }, { ifMatchRev: thawed.rev });
    expect(renamed.title).toBe("writable again");
    // re-freeze for the delete test
    await client.patchCard(
      FROZ,
      { frozen: { at: new Date().toISOString(), reason: "conversations-migration-v1", by: "alpha" } },
      { ifMatchRev: renamed.rev }
    );
  });

  it("DELETE stays allowed on a frozen card (cleanup path, user decision D-3)", async () => {
    const card = await client.getCard(FROZ);
    const res = await client.deleteCard(FROZ, { ifMatchRev: card.rev });
    expect(res.deleted).toBe(true);
    expect(await client.getCard(FROZ)).toBeNull();
  });
});

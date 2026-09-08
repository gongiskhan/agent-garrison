// The standing Zeca conversation (D60): one long-running thread every spoken
// "Zeca" lands in, created on first ask, rotated by the nightly review with the
// old file left in place.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The threads store resolves its dir from GARRISON_HOME at module load, so point
// it at a temp home BEFORE importing.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "talk-zeca-"));
const ZECA = pathToFileURL(path.resolve(__dirname, "../packages/talk/src/zeca.mjs")).href;
const THREADS = pathToFileURL(path.resolve(__dirname, "../packages/talk/src/threads.mjs")).href;

type Loose = Record<string, any>;
interface ZecaModule {
  ZECA_TITLE: string;
  ZECA_DUTY: string;
  ZECA_SOURCE: string;
  zecaPointerPath(): string;
  newZecaThreadId(now?: Date): string;
  zecaConversation(opts?: { nowIso?: string }): Promise<Loose>;
  rotateZecaConversation(opts?: { nowIso?: string; reason?: string }): Promise<Loose>;
}
let zeca: ZecaModule;
let threads: Loose;
let prevHome: string | undefined;

beforeAll(async () => {
  prevHome = process.env.GARRISON_HOME;
  process.env.GARRISON_HOME = TMP_HOME;
  zeca = (await import(ZECA)) as ZecaModule;
  threads = await import(THREADS);
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.GARRISON_HOME;
  else process.env.GARRISON_HOME = prevHome;
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

describe("the standing Zeca conversation", () => {
  it("is created on first ask and answered the same afterwards", async () => {
    const first = await zeca.zecaConversation({ nowIso: "2026-09-04T08:00:00.000Z" });
    expect(first.conversationId).toMatch(/^zeca-20260904t080000z-[a-z0-9]{4}$/);
    expect(first.since).toBe("2026-09-04T08:00:00.000Z");
    expect(first.previous).toEqual([]);
    const thread = await threads.getThread(first.conversationId);
    expect(thread).toMatchObject({ id: first.conversationId, title: zeca.ZECA_TITLE, source: zeca.ZECA_SOURCE });
    // Pinned to the one user-facing duty at creation (D62). Unpinned, a spoken
    // "what time is it in Lisbon" opened the delivery loop - triage, plan on
    // Sonnet, test - two minutes of stretches and no answer, because the reply
    // the phone waits for is the `discuss` duty's.
    expect(thread?.routing).toEqual({ duty: zeca.ZECA_DUTY, level: 1 });

    const again = await zeca.zecaConversation({ nowIso: "2026-09-04T09:00:00.000Z" });
    expect(again.conversationId).toBe(first.conversationId);
    expect(JSON.parse(fs.readFileSync(zeca.zecaPointerPath(), "utf8")).conversationId).toBe(first.conversationId);
  });

  it("agrees on one id when two first asks race", async () => {
    fs.rmSync(zeca.zecaPointerPath(), { force: true });
    const [a, b] = await Promise.all([zeca.zecaConversation(), zeca.zecaConversation()]);
    expect(a.conversationId).toBe(b.conversationId);
  });

  it("rotates: the old thread keeps its file under a dated title, a fresh one takes the name", async () => {
    const before = await zeca.zecaConversation();
    await threads.appendMessages(before.conversationId, [{ role: "user", text: "Zeca, remember the milk" }]);

    const rotated = await zeca.rotateZecaConversation({ nowIso: "2026-09-05T03:05:00.000Z", reason: "nightly-review" });
    expect(rotated.rotated).toBe(before.conversationId);
    expect(rotated.conversationId).not.toBe(before.conversationId);
    expect(rotated.since).toBe("2026-09-05T03:05:00.000Z");
    expect(rotated.previous[0]).toMatchObject({
      conversationId: before.conversationId,
      until: "2026-09-05T03:05:00.000Z",
      reason: "nightly-review"
    });

    const old = await threads.getThread(before.conversationId);
    expect(old.title).toBe("Zeca until 2026-09-05");
    expect(old.messages).toHaveLength(1);
    const fresh = await threads.getThread(rotated.conversationId);
    expect(fresh).toMatchObject({ title: zeca.ZECA_TITLE, source: zeca.ZECA_SOURCE });
    expect(fresh.messages ?? []).toHaveLength(0);
    // Every rotation, not just the first creation: a conversation that loses
    // the pin overnight is a conversation that answers in two minutes again.
    expect(fresh.routing).toEqual({ duty: zeca.ZECA_DUTY, level: 1 });

    expect((await zeca.zecaConversation()).conversationId).toBe(rotated.conversationId);
  });

  it("re-creates the conversation when the pointed thread was deleted", async () => {
    const current = await zeca.zecaConversation();
    await threads.deleteThread(current.conversationId);
    const next = await zeca.zecaConversation();
    expect(next.conversationId).not.toBe(current.conversationId);
    expect(await threads.getThread(next.conversationId)).not.toBeNull();
  });
});

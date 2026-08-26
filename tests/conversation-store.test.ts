// The conversation store substrate (Conversations plan): multi-process
// O_APPEND appends, line-order indexing, payload spill, log roll, write guard.
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-ignore — pure .mjs
import {
  ConversationStore,
  openConversation,
  listConversations,
  conversationDir,
  newConversationId,
  PAYLOAD_INLINE_CAP_BYTES,
} from "../packages/claude-pty/src/conversation-store.mjs";

let tmp: string;
let env: Record<string, string>;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "convstore-"));
  env = { GARRISON_HOME: tmp };
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("ConversationStore", () => {
  it("appends events; order is line order; seq is per-writer", () => {
    const a = openConversation("c1", { role: "gateway", env });
    const b = openConversation("c1", { role: "board", env });
    expect(a.append({ kind: "conversation-opened", payload: {} }).seq).toBe(0);
    expect(b.append({ kind: "card-state-changed", payload: {} }).seq).toBe(0); // per-writer
    expect(a.append({ kind: "stretch-started", stretch: "s1", duty: "triage", payload: {} }).seq).toBe(1);
    const { events } = a.range({});
    expect(events.map((e: any) => e.kind)).toEqual(["conversation-opened", "card-state-changed", "stretch-started"]);
    expect(events.map((e: any) => e.index)).toEqual([0, 1, 2]);
    expect(events[0].writer).toMatch(/^gateway:\d+$/);
    expect(events[1].writer).toMatch(/^board:\d+$/);
  });

  it("survives 2 concurrent child processes appending 200 records each with zero torn lines", () => {
    const script = `
      import { openConversation } from ${JSON.stringify(path.resolve("packages/claude-pty/src/conversation-store.mjs"))};
      const store = openConversation("c-conc", { role: process.argv[2] });
      for (let i = 0; i < 200; i++) store.append({ kind: "user-message", payload: { i, role: process.argv[2], pad: "x".repeat(500) } });
    `;
    const scriptFile = path.join(tmp, "writer.mjs");
    writeFileSync(scriptFile, script);
    const run = (role: string) =>
      new Promise<void>((resolve, reject) => {
        import("node:child_process").then(({ execFile }) => {
          execFile(process.execPath, [scriptFile, role], { env: { ...process.env, GARRISON_HOME: tmp } }, (err) =>
            err ? reject(err) : resolve()
          );
        });
      });
    return Promise.all([run("gateway"), run("board")]).then(() => {
      const text = readFileSync(path.join(conversationDir("c-conc", env), "log.jsonl"), "utf8");
      const lines = text.trim().split("\n");
      expect(lines).toHaveLength(400);
      for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
      const store = openConversation("c-conc", { env });
      const gw = store.tail(500).filter((e: any) => e.writer.startsWith("gateway:"));
      expect(gw.map((e: any) => e.seq)).toEqual([...Array(200).keys()]); // per-writer seq intact
    });
  });

  it("spills oversized payloads content-addressed with a verifiable pointer", () => {
    const store = openConversation("c2", { role: "gateway", env });
    const big = { blob: "y".repeat(PAYLOAD_INLINE_CAP_BYTES + 100) };
    store.append({ kind: "delegation-returned", payload: big });
    const [evt] = store.tail(1);
    expect(evt.payload.spilled).toMatch(/^payloads\/[0-9a-f]{16}\.json$/);
    expect(evt.payload.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(store.readPayload(evt.payload.spilled)).toEqual(big);
    // content-addressed: same payload again produces the same ref
    store.append({ kind: "delegation-returned", payload: big });
    const [, evt2] = store.tail(2);
    expect(evt2.payload.spilled).toBe(evt.payload.spilled);
  });

  it("named payloads cap explicitly and refuse escaping refs", () => {
    const store = openConversation("c3", { role: "bridge", env });
    const res = store.writeNamedPayload("delegation-d1.md", "z".repeat(50), { maxBytes: 10 });
    expect(res.truncated).toBe(true);
    expect(store.readPayload(res.ref)).toBe("z".repeat(10));
    expect(store.readPayload("payloads/../../secrets")).toBeNull();
    expect(store.readPayload("/etc/passwd")).toBeNull();
  });

  it("rolls the log into immutable segments and keeps indexes stable", () => {
    const store = openConversation("c4", { role: "gateway", env });
    store.append({ kind: "conversation-opened", payload: {} });
    store.append({ kind: "user-message", payload: { text: "one" } });
    // Force a roll by shrinking the threshold via a manual rename (the roll
    // itself is a rename; simulate it to prove readers span segments).
    const dir = conversationDir("c4", env);
    const rolled = path.join(dir, `log.${Date.now()}.jsonl`);
    renameSync(path.join(dir, "log.jsonl"), rolled);
    store.append({ kind: "user-message", payload: { text: "two" } });
    const { events } = store.range({});
    expect(events.map((e: any) => e.index)).toEqual([0, 1, 2]);
    expect(events[2].payload.text).toBe("two");
    expect(store.range({ fromIndex: 2 }).events).toHaveLength(1);
  });

  it("claimStretch is exclusive; release requires the holder", () => {
    const store = openConversation("c5", { role: "gateway", env });
    expect(store.claimStretch("s1")).toBe(true);
    expect(store.claimStretch("s2")).toBe(false);
    expect(store.currentStretch()).toBe("s1");
    expect(store.releaseStretch("s2")).toBe(false);
    expect(store.releaseStretch("s1")).toBe(true);
    expect(store.currentStretch()).toBeNull();
    expect(store.claimStretch("s2")).toBe(true);
  });

  it("init is idempotent and emits conversation-opened once", () => {
    const store = openConversation("c6", { role: "gateway", env });
    expect(store.init({ title: "T", objective: "obj" }).opened).toBe(true);
    expect(store.init({ title: "T" }).opened).toBe(false);
    expect(store.count("conversation-opened")).toBe(1);
    expect(store.readSummary()).toContain("## Escalation floor");
  });

  it("unknown kinds are stored verbatim; grep and count filter", () => {
    const store = openConversation("c7", { role: "gateway", env });
    store.append({ kind: "some-future-kind", payload: { note: "greppable-needle" } });
    store.append({ kind: "handoff", duty: "implement", payload: {} });
    store.append({ kind: "handoff", duty: "review", payload: {} });
    expect(store.grep("greppable-needle")).toHaveLength(1);
    expect(store.count("handoff")).toBe(2);
    expect(store.count("handoff", { duty: "review" })).toBe(1);
  });

  it("listConversations sees stores; ids sanitize; ULIDs mint", () => {
    openConversation("c8", { role: "gateway", env }).append({ kind: "conversation-opened", payload: null });
    expect(listConversations(env).map((c: any) => c.id)).toContain("c8");
    expect(newConversationId()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const evil = openConversation("../../escape", { role: "gateway", env });
    expect(evil.dir.startsWith(path.join(tmp, "conversations"))).toBe(true);
  });

  it("append never throws even when the payload is unserializable", () => {
    const store = openConversation("c9", { role: "gateway", env });
    const cyc: any = {};
    cyc.self = cyc;
    const res = store.append({ kind: "user-message", payload: cyc });
    expect(res.ok).toBe(true);
  });
});

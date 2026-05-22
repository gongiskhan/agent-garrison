import { describe, expect, it } from "vitest";
import path from "node:path";

const LIB_DIR = path.resolve(__dirname, "..", "fittings", "seed", "http-gateway", "scripts", "lib");

describe("http-gateway libs (Phase 9B)", () => {
  describe("jsonl-watcher / projectDirForCwd", () => {
    it("converts slashes to dashes, keeping the leading dash", async () => {
      const mod = await import(path.join(LIB_DIR, "jsonl-watcher.mjs"));
      expect(mod.projectDirForCwd("/Users/ggomes/Projects/agent-garrison")).toBe(
        "-Users-ggomes-Projects-agent-garrison"
      );
      expect(mod.projectDirForCwd("/tmp/x")).toBe("-tmp-x");
    });

    it("builds JSONL path under ~/.claude/projects/<dir>/<sid>.jsonl", async () => {
      const mod = await import(path.join(LIB_DIR, "jsonl-watcher.mjs"));
      const p = mod.jsonlPath("/foo/bar", "abc-123");
      expect(p).toContain(".claude/projects/-foo-bar/abc-123.jsonl");
    });
  });

  describe("channels", () => {
    it("publishes to subscribers bound to the session's channel", async () => {
      const { ChannelHub } = await import(path.join(LIB_DIR, "channels.mjs"));
      const hub = new ChannelHub();
      hub.bindSession("s1", "main");
      const seen: any[] = [];
      hub.subscribe("main", (ev: any) => seen.push(ev));
      hub.publish("s1", "engineer", { type: "assistant", message: { content: [] } });
      expect(seen).toHaveLength(1);
      expect(seen[0].session_id).toBe("s1");
      expect(seen[0].soul).toBe("engineer");
    });

    it("replays ring buffer on subscribe", async () => {
      const { ChannelHub } = await import(path.join(LIB_DIR, "channels.mjs"));
      const hub = new ChannelHub();
      hub.bindSession("s1", "main");
      hub.publish("s1", "engineer", { type: "assistant", text: "first" });
      hub.publish("s1", "engineer", { type: "assistant", text: "second" });
      const seen: any[] = [];
      hub.subscribe("main", (ev: any) => seen.push(ev));
      expect(seen).toHaveLength(2);
    });
  });

  describe("session-registry", () => {
    it("tracks sessions by id and by soul, list filters by mode/soul", async () => {
      const { SessionRegistry } = await import(path.join(LIB_DIR, "session-registry.mjs"));
      const reg = new SessionRegistry();
      reg.register({ sessionId: "a", soul: "engineer", mode: "headless" });
      reg.register({ sessionId: "b", soul: "architect", mode: "interactive" });
      expect(reg.get("a")?.soul).toBe("engineer");
      expect(reg.bySoul("architect")?.sessionId).toBe("b");
      expect(reg.list({ mode: "interactive" })).toHaveLength(1);
      expect(reg.list({ soul: "engineer" })).toHaveLength(1);
    });

    it("setSummary collects pendingSummaries and drainPendingSummaries marks acknowledged", async () => {
      const { SessionRegistry } = await import(path.join(LIB_DIR, "session-registry.mjs"));
      const reg = new SessionRegistry();
      reg.register({ sessionId: "x", soul: "engineer", mode: "headless" });
      reg.setSummary("x", "all done");
      const drained1 = reg.drainPendingSummaries();
      expect(drained1).toHaveLength(1);
      expect(drained1[0].summary).toBe("all done");
      const drained2 = reg.drainPendingSummaries();
      expect(drained2).toHaveLength(0);
    });

    it("addWaiter resolves on resolveWaiters", async () => {
      const { SessionRegistry } = await import(path.join(LIB_DIR, "session-registry.mjs"));
      const reg = new SessionRegistry();
      reg.register({ sessionId: "y", soul: "engineer", mode: "headless", status: "running" });
      reg.setSummary("y", "ok");
      const promise = reg.addWaiter("y");
      reg.resolveWaiters("y");
      const result: any = await promise;
      expect(result.summary).toBe("ok");
    });
  });

  describe("orchestrator-prefix", () => {
    it("includes origin and channel lines, no summaries when none pending", async () => {
      const mod = await import(path.join(LIB_DIR, "orchestrator-prefix.mjs"));
      const out = mod.buildOrchestratorTurn({ origin: "ui-tab", channel: "main", message: "hi" });
      expect(out.startsWith("[origin: ui-tab, channel: main]")).toBe(true);
      expect(out.endsWith("hi")).toBe(true);
      expect(out).not.toContain("Recent sub-session summaries");
    });

    it("prepends pending summaries when present", async () => {
      const mod = await import(path.join(LIB_DIR, "orchestrator-prefix.mjs"));
      const out = mod.buildOrchestratorTurn({
        origin: "channel",
        channel: "main",
        message: "next?",
        pendingSummaries: [{ soul: "engineer", sessionId: "abc12345-x", summary: "fixed bug" }]
      });
      expect(out).toContain("Recent sub-session summaries");
      expect(out).toContain("engineer/abc12345");
      expect(out).toContain("fixed bug");
    });
  });
});

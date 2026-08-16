// The web-channel UI's half of the 2026-07-25 run-context contract (§10, §11).
//
// main.tsx MOUNTS ITSELF (top-level createRoot), so it is driven here through the
// smallest possible stubs - a fake window/document plus a mocked react-dom/client -
// rather than left untested. What is pinned is the pure logic the badges depend on:
//   • toHistory carries the persisted `route` / `overrides` onto the exchange's
//     ASSISTANT side, which is the hop that makes badges survive both a reload and
//     the 10s thread poll's re-mount (§10 hops 4-5);
//   • apiRouteOptions turns the proxy's per-side `sources` flags into per-dimension
//     "why you cannot pin this" reasons instead of an empty menu that reads as "you
//     have no projects" (§11).

import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SessionBlock } from "@garrison/claude-chat";
// @ts-ignore — dependency-free fitting JavaScript intentionally has no .d.ts.
import { normalizeAgentSdkMessages } from "../fittings/seed/agent-sdk-runtime/lib/session-events.mjs";

const SDK_FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/agent-sdk-web-parity-events.json", import.meta.url)), "utf8")
);

function settledFixtureEvents(turnId: string) {
  let now = 1_786_880_000_000;
  const revisions = normalizeAgentSdkMessages(SDK_FIXTURE.messages, { turnId, now: () => now++ });
  const latest = new Map<string, any>();
  for (const event of revisions) latest.set(event.id, event);
  return [...latest.values()];
}

// react-dom/client is the ONLY import with a real DOM requirement at module scope.
vi.mock("react-dom/client", () => ({
  createRoot: () => ({ render: () => {}, unmount: () => {} }),
}));

// Installed at MODULE scope, not in a hook: main.tsx reads the URL and mounts itself
// as it is imported, which happens before any beforeAll runs.
(globalThis as any).window = {
  location: { search: "", hostname: "localhost", protocol: "http:", href: "http://localhost/" },
  addEventListener: () => {},
  removeEventListener: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
};
(globalThis as any).document = {
  getElementById: () => ({}),
  visibilityState: "visible",
  addEventListener: () => {},
  removeEventListener: () => {},
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// The repo's tsconfig sets jsx:"preserve", so vitest's esbuild uses the CLASSIC JSX
// transform and emits bare `React.createElement` calls - while main.tsx is built for
// production with the AUTOMATIC runtime (ui/build.mjs) and therefore imports no React
// of its own. A global satisfies the emitted calls without touching the source.
const reactMod = await import("react");
(globalThis as any).React = (reactMod as any).default ?? reactMod;
const { renderToStaticMarkup } = await import("react-dom/server");

const ui = await import("../fittings/seed/web-channel-default/ui/main");

describe("web-channel push notices", () => {
  it("gives blocked/install notices and transient notifications a separate accessible close", () => {
    const dismissed = vi.fn();
    const noticeElement = (globalThis as any).React.createElement(ui.PushNotice, {
      text: "Notifications blocked",
      onDismiss: dismissed,
    });
    const notice = renderToStaticMarkup(noticeElement);
    const toast = renderToStaticMarkup(
      (globalThis as any).React.createElement(ui.PushNotice, { kind: "toast", text: "Task complete", onDismiss: () => {} })
    );
    expect(notice).toContain("wc-push-notice");
    expect(notice).toContain('aria-label="Dismiss notification notice"');
    expect(toast).toContain("wc-push-toast");
    expect(toast).toContain('aria-label="Dismiss notification"');
    // PushNotice owns no enrolment behavior: its close control performs only the
    // dismissal callback supplied by PushEnroller.
    const renderedNotice = ui.PushNotice(noticeElement.props);
    renderedNotice.props.children[1].props.onClick();
    expect(dismissed).toHaveBeenCalledOnce();
  });
});

describe("web-channel toHistory: run context survives a reload (contract §10)", () => {
  it("detects an in-place canonical revision even when message and event counts stay fixed", () => {
    const base: any = {
      messages: [{ role: "user", text: "run it", ts: "2026-08-16T10:00:00.000Z" }],
      sessionEvents: [{ id: "tool", role: "assistant", ts: 1, order: 1, revision: 1, blocks: [{ type: "tool_use" }] }],
    };
    const revised = {
      ...base,
      sessionEvents: [{ ...base.sessionEvents[0], revision: 2, blocks: [{ type: "tool_use", input: "complete" }] }],
    };
    expect(ui.threadHistoryRevision(revised)).not.toBe(ui.threadHistoryRevision(base));
  });

  it("refreshes a painted terminal snapshot without remounting, but remounts missed replay recovery", () => {
    const before: any = {
      messages: [{ role: "user", text: "speak this", turnId: "input-voice" }],
      sessionEvents: [],
      pendingInputs: [{ inputId: "input-voice", clientRequestId: "voice-client", state: "running" }],
      inputRevision: 2,
    };
    const settled: any = {
      messages: [
        ...before.messages,
        { role: "assistant", text: "spoken answer", turnId: "input-voice" },
      ],
      sessionEvents: [],
      pendingInputs: [],
      inputRevision: 3,
    };
    expect(ui.shouldRemountAfterResume(before, settled, false)).toBe(false);
    expect(ui.shouldRemountAfterResume(before, settled, true)).toBe(true);
  });

  it("hydrates the active input onto its durable user row and appends queued rows in FIFO order", () => {
    const active = {
      clientRequestId: "client-active",
      inputId: "input-active",
      state: "running" as const,
      generationId: "generation-active",
      acceptedAt: "2026-08-16T10:00:00.000Z",
      message: "active ask",
    };
    const queued = {
      clientRequestId: "client-queued",
      inputId: "input-queued",
      state: "queued" as const,
      position: 1,
      acceptedAt: "2026-08-16T10:00:01.000Z",
      message: "queued ask",
    };
    const history = ui.toHistory([
      { role: "user", text: "active ask", turnId: "input-active", ts: active.acceptedAt },
    ], [], [active, queued]);
    expect(history).toEqual([
      {
        user: "active ask",
        assistant: "",
        input: {
          clientRequestId: "client-active",
          inputId: "input-active",
          state: "running",
          generationId: "generation-active",
          acceptedAt: active.acceptedAt,
        },
      },
      {
        user: "queued ask",
        assistant: "",
        input: {
          clientRequestId: "client-queued",
          inputId: "input-queued",
          state: "queued",
          position: 1,
          acceptedAt: queued.acceptedAt,
        },
      },
    ]);
    expect(ui.threadHistoryRevision({ messages: [], sessionEvents: [], inputRevision: 2, pendingInputs: [active, queued] }))
      .not.toBe(ui.threadHistoryRevision({ messages: [], sessionEvents: [], inputRevision: 1, pendingInputs: [active] }));
  });

  it("carries the assistant message's route and the user message's overrides onto the pair", () => {
    const h = ui.toHistory([
      { role: "user", text: "plan it", overrides: { duty: "plan", level: 2 } },
      {
        role: "assistant",
        text: "Here is the plan.",
        route: { duty: "plan", level: 2, runtime: "agent-sdk", sessionId: "sess-1" },
      },
    ]);
    expect(h).toHaveLength(1);
    expect(h[0]).toEqual({
      user: "plan it",
      assistant: "Here is the plan.",
      route: { duty: "plan", level: 2, runtime: "agent-sdk", sessionId: "sess-1" },
      overrides: { duty: "plan", level: 2 },
    });
  });

  it("keeps each exchange's own attribution across a multi-turn thread", () => {
    const h = ui.toHistory([
      { role: "user", text: "one" },
      { role: "assistant", text: "1", route: { sessionId: "a" } },
      { role: "user", text: "two", overrides: { project: "garrison" } },
      { role: "assistant", text: "2", route: { sessionId: "b", project: "garrison" } },
    ]);
    expect(h.map((e) => e.route?.sessionId)).toEqual(["a", "b"]);
    expect(h[0].overrides).toBeUndefined();
    expect(h[1].overrides).toEqual({ project: "garrison" });
  });

  it("omits the keys entirely for a legacy message with no run context", () => {
    const h = ui.toHistory([
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ]);
    // An absent key (not `route: undefined`) is what keeps the seeded Turn free of a
    // fake, empty attribution - the rail then falls back to the legacy chip.
    expect(Object.keys(h[0]).sort()).toEqual(["assistant", "user"]);
  });

  it("still pairs a trailing unanswered user turn, keeping its pins", () => {
    const h = ui.toHistory([
      { role: "user", text: "one" },
      { role: "assistant", text: "1" },
      { role: "user", text: "two", overrides: { effort: "high" } },
    ]);
    expect(h).toHaveLength(2);
    expect(h[1]).toEqual({ user: "two", assistant: "", overrides: { effort: "high" } });
  });

  it("pairs two consecutive user turns without swallowing the first", () => {
    const h = ui.toHistory([
      { role: "user", text: "one", overrides: { duty: "plan" } },
      { role: "user", text: "two" },
      { role: "assistant", text: "2", route: { duty: "execute" } },
    ]);
    expect(h).toEqual([
      { user: "one", assistant: "", overrides: { duty: "plan" } },
      { user: "two", assistant: "2", route: { duty: "execute" } },
    ]);
  });

  it("keeps an interleaved external assistant notice separate from an exact input reply", () => {
    const history = ui.toHistory([
      { role: "user", text: "run the input", turnId: "input-1", ts: "2026-08-16T10:00:00.000Z" },
      { role: "assistant", text: "external card update", ts: "2026-08-16T10:00:01.000Z" },
      {
        role: "assistant",
        text: "exact input answer",
        turnId: "input-1",
        ts: "2026-08-16T10:00:02.000Z",
        route: { runtime: "agent-sdk", generationId: "generation-1" },
      },
    ] as any);
    expect(history).toEqual([
      {
        user: "run the input",
        assistant: "exact input answer",
        route: { runtime: "agent-sdk", generationId: "generation-1" },
      },
      { user: "", assistant: "external card update" },
    ]);
  });

  it("hydrates the authentic two-tool fixture onto its explicitly numbered exchange", () => {
    const canonical = settledFixtureEvents("1");
    const h = ui.toHistory([
      { role: "user", text: "run the fixture", ts: "2026-08-16T10:00:00.000Z" },
      {
        role: "assistant",
        text: "WEB_PARITY_FIXTURE",
        ts: "2026-08-16T10:00:05.000Z",
        route: { turnSeq: 1, sessionId: "session-53" },
      },
    ], canonical);

    expect(h[0].sessionEvents).toEqual(canonical);
    expect(h[0].sessionEvents?.[0]).toBe(canonical[0]);
    const blocks = h[0].sessionEvents?.flatMap((event: any) => event.blocks) ?? [];
    expect(blocks.filter((block: any) => block.type === "tool_use").map((block: any) => block.name)).toEqual(["Write", "Read"]);
    expect(blocks.find((block: any) => block.type === "text" && block.text === "WEB_PARITY_FIXTURE")).toBeDefined();
  });

  it("prefers explicit turnId coordinates over contradictory timestamps", () => {
    const event = (id: string, turnId: string, ts: number) => ({
      id,
      role: "assistant",
      ts,
      turnId,
      sessionId: "same-session",
      order: 1,
      revision: 1,
      blocks: [{ type: "text", text: id }],
    });
    const first = event("first-event", "1", Date.parse("2026-08-16T10:01:30.000Z"));
    const second = event("second-event", "2", Date.parse("2026-08-16T10:00:30.000Z"));
    const h = ui.toHistory([
      { role: "user", text: "one", ts: "2026-08-16T10:00:00.000Z" },
      { role: "assistant", text: "1", ts: "2026-08-16T10:00:10.000Z", route: { turnSeq: 1, sessionId: "same-session" } },
      { role: "user", text: "two", ts: "2026-08-16T10:01:00.000Z" },
      { role: "assistant", text: "2", ts: "2026-08-16T10:01:10.000Z", route: { turnSeq: 2, sessionId: "same-session" } },
    ], [first, second]);

    expect(h[0].sessionEvents?.map((entry: any) => entry.id)).toEqual(["first-event"]);
    expect(h[1].sessionEvents?.map((entry: any) => entry.id)).toEqual(["second-event"]);
  });

  it("uses timestamps before session id when a reloaded client reuses its turn counter", () => {
    const h = ui.toHistory([
      { role: "user", text: "old", ts: "2026-08-16T10:00:00.000Z", turnId: "1" },
      {
        role: "assistant",
        text: "old reply",
        ts: "2026-08-16T10:00:10.000Z",
        route: { turnSeq: 1, sessionId: "session-old" },
      },
      // The ask is persisted before routing settles, so it has the repeated
      // client turn id but no runtime session id yet.
      { role: "user", text: "new", ts: "2026-08-16T10:01:00.000Z", turnId: "1" },
    ], [{
      id: "new-early-event",
      role: "assistant",
      ts: Date.parse("2026-08-16T10:01:05.000Z"),
      turnId: "1",
      sessionId: "session-old",
      order: 1,
      revision: 1,
      blocks: [{ type: "tool_use", name: "Read", toolUseId: "read-new" }],
    }]);

    expect(h[0].sessionEvents).toBeUndefined();
    expect(h[1].sessionEvents?.map((entry: any) => entry.id)).toEqual(["new-early-event"]);
  });

  it("keeps early s2 activity on a trailing repeated turn after the prior turn rolls from s2 to s53", () => {
    const sessionEvent = (
      id: string,
      ts: string,
      sessionId: string,
      order: number,
      blocks: SessionBlock[]
    ) => ({
      id,
      role: "assistant",
      ts: Date.parse(ts),
      turnId: "1",
      sessionId,
      order,
      revision: 1,
      blocks,
    });
    const h = ui.toHistory([
      { role: "user", text: "old turn", ts: "2026-08-16T10:00:00.000Z", turnId: "1" },
      {
        role: "assistant",
        text: "old reply",
        ts: "2026-08-16T10:00:10.000Z",
        route: { turnSeq: 1, sessionId: "s2" },
      },
      // A browser remount resets turnSeq to 1. This ask is already durable, but
      // it is intentionally unanswered while its early SDK activity arrives.
      { role: "user", text: "new turn", ts: "2026-08-16T10:01:00.000Z", turnId: "1" },
    ], [
      sessionEvent("old-early-s2", "2026-08-16T10:00:02.000Z", "s2", 1, [
        { type: "tool_use", name: "Write", toolUseId: "write-old" },
      ]),
      sessionEvent("old-terminal-s53", "2026-08-16T10:00:08.000Z", "s53", 2, [
        { type: "turn_end", status: "completed" },
      ]),
      // A new normalizer starts at order 1 and initially reports s2 again. Exact
      // session matching must not drag this group back onto the old s2 reply.
      sessionEvent("new-early-s2", "2026-08-16T10:01:02.000Z", "s2", 1, [
        { type: "tool_use", name: "Read", toolUseId: "read-new" },
      ]),
    ]);

    expect(h).toHaveLength(2);
    expect(h[0].sessionEvents?.map((event: any) => event.id)).toEqual([
      "old-early-s2",
      "old-terminal-s53",
    ]);
    expect(h[1]).toMatchObject({ user: "new turn", assistant: "" });
    expect(h[1].sessionEvents?.map((event: any) => event.id)).toEqual(["new-early-s2"]);
  });

  it("falls back to message timestamps when no explicit turn coordinate matches", () => {
    const event = (id: string, ts: string) => ({
      id,
      role: "assistant",
      ts: Date.parse(ts),
      order: 1,
      revision: 1,
      blocks: [{ type: "text", text: id }],
    });
    const h = ui.toHistory([
      { role: "user", text: "one", ts: "2026-08-16T10:00:00.000Z" },
      { role: "assistant", text: "1", ts: "2026-08-16T10:00:20.000Z" },
      { role: "user", text: "two", ts: "2026-08-16T10:01:00.000Z" },
      { role: "assistant", text: "2", ts: "2026-08-16T10:01:20.000Z" },
    ], [
      event("first-by-time", "2026-08-16T10:00:10.000Z"),
      event("second-by-time", "2026-08-16T10:01:10.000Z"),
    ]);

    expect(h.map((exchange: any) => exchange.sessionEvents?.[0]?.id)).toEqual(["first-by-time", "second-by-time"]);
  });

  it("uses stable persisted sequence when neither coordinates nor timestamps can disambiguate", () => {
    const events = ["first-by-sequence", "second-by-sequence"].map((id, index) => ({
      id,
      role: "assistant",
      ts: null,
      turnId: `legacy-${index}`,
      order: 1,
      revision: 1,
      blocks: [{ type: "text", text: id }],
    }));
    const h = ui.toHistory([
      { role: "user", text: "one" },
      { role: "assistant", text: "1" },
      { role: "user", text: "two" },
      { role: "assistant", text: "2" },
    ], events);

    expect(h.map((exchange: any) => exchange.sessionEvents?.[0]?.id)).toEqual(["first-by-sequence", "second-by-sequence"]);
  });
});

describe("web-channel apiRouteOptions: per-dimension degradation (contract §11)", () => {
  const answer = (body: unknown, ok = true) => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: any) => {
      calls.push(String(url));
      return new Response(JSON.stringify(body), {
        status: ok ? 200 : 500,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return calls;
  };

  it("passes the menu vocabulary through and reports nothing unavailable when both sides answered", async () => {
    const calls = answer({
      targets: [{ id: "cc-sonnet-med", runtime: "agent-sdk", model: "claude-sonnet-4-6" }],
      duties: [{ id: "plan", title: "Plan", levels: [{ n: 1, description: "sketch" }] }],
      efforts: ["low", "medium", "high", "xhigh", "max"],
      accounts: [{ name: "work", platform: "anthropic" }],
      projects: ["garrison", "ekoa"],
      sources: { gateway: true, board: true },
    });
    const o = await ui.apiRouteOptions(false);
    expect(calls).toEqual(["/api/route-options"]);
    expect(o?.targets).toHaveLength(1);
    expect(o?.duties?.[0].levels?.[0]).toEqual({ n: 1, description: "sketch" });
    expect(o?.projects).toEqual(["garrison", "ekoa"]);
    expect(o?.unavailable).toBeUndefined();
  });

  it("names the board when the project list has no source, leaving routing pinnable", async () => {
    answer({ targets: [{ id: "t" }], efforts: ["low"], projects: [], sources: { gateway: true, board: false } });
    const o = await ui.apiRouteOptions(false);
    expect(o?.unavailable?.project).toMatch(/kanban board is not running/);
    // The gateway answered, so nothing else is disabled.
    expect(o?.unavailable?.effort).toBeUndefined();
    expect(o?.unavailable?.target).toBeUndefined();
  });

  it("names the gateway for every routing dimension when it did not answer", async () => {
    answer({ targets: [], duties: [], efforts: [], accounts: [], projects: ["garrison"], sources: { gateway: false, board: true } });
    const o = await ui.apiRouteOptions(false);
    for (const field of ["target", "model", "effort", "duty", "account"] as const) {
      expect(o?.unavailable?.[field]).toMatch(/gateway is not answering/);
    }
    // The board still answered, so the project menu stays live.
    expect(o?.unavailable?.project).toBeUndefined();
    expect(o?.projects).toEqual(["garrison"]);
  });

  it("bypasses the proxy cache when asked to revalidate", async () => {
    const calls = answer({ sources: { gateway: true, board: true } });
    await ui.apiRouteOptions(true);
    expect(calls).toEqual(["/api/route-options?refresh=1"]);
  });

  it("degrades to read-only (null) on a failed read rather than throwing at the chat", async () => {
    answer({}, false);
    expect(await ui.apiRouteOptions(false)).toBeNull();
    globalThis.fetch = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await ui.apiRouteOptions(false)).toBeNull();
  });

  it("survives a malformed payload: a non-array dimension becomes an empty menu, not a crash", async () => {
    answer({ targets: "nope", duties: null, efforts: 7, accounts: {}, projects: "garrison", sources: { gateway: true, board: true } });
    const o = await ui.apiRouteOptions(false);
    expect(o).toMatchObject({ targets: [], duties: [], efforts: [], accounts: [], projects: [] });
  });
});

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

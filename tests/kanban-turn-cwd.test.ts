// A card's turn must run IN the card's project repo.
//
// gatewayRunFn never sent the card's project, so `preRouteV4` returned a null
// projectPath and the gateway fell back to GARRISON_COMPOSITION_DIR — every kanban
// card's turn executed in the composition directory. Work still landed in the right
// repo, but only because the prompt named the project and the agent navigated there
// itself; nothing in the dispatch made it so.
//
// The project rides `routing`, NOT a bare top-level `project`: `body.project` already
// means the D19 card-creation label on other channels, so giving it cwd meaning would
// silently change their behaviour. `routing.project` is the pinned-intent channel the
// gateway validates at the edge and resolves to a git repo under the dev root — and an
// unresolvable name is REJECTED rather than silently run in the composition dir.
import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// @ts-ignore pure mjs
import { gatewayRunFn, routeFromDone } from "../fittings/seed/kanban-loop/lib/gateway-client.mjs";
// @ts-ignore pure mjs
import { routeStamp } from "../fittings/seed/kanban-loop/lib/engine.mjs";
import { execBadges } from "../fittings/seed/kanban-loop/ui/exec-badges";
// @ts-ignore pure mjs
import { batchGatewayRunFn } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";
// @ts-ignore pure mjs
import { sanitizeRouting } from "../fittings/seed/http-gateway/scripts/gateway-pty.mjs";
// @ts-ignore pure mjs
import { applyTurnOverride } from "../fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs";

// A gateway stub that captures ONE request body and returns a minimal SSE turn.
async function captureBody(run: (url: string) => Promise<unknown>): Promise<any> {
  let captured: any = null;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { captured = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { captured = null; }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: done\ndata: ${JSON.stringify({ reply: "review" })}\n\n`);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
  return captured;
}

describe("the kanban dispatch tells the gateway which project the turn runs in", () => {
  it("sends the card's project as routing.project", async () => {
    const body = await captureBody((url) =>
      gatewayRunFn(url)({
        prompt: "do the thing",
        card: { id: "c1", project: "ekoa-code" },
        duty: "code",
        level: 2,
        phase: "code",
        list: {}
      })
    );
    expect(body.routing).toEqual({ project: "ekoa-code" });
  });

  it("does NOT overload the top-level `project` field, which means something else on other channels", async () => {
    const body = await captureBody((url) =>
      gatewayRunFn(url)({ prompt: "x", card: { id: "c1", project: "ekoa-code" }, list: {} })
    );
    expect(body.project).toBeUndefined();
  });

  it("omits routing entirely for a card with no project — never invents a cwd", async () => {
    const body = await captureBody((url) =>
      gatewayRunFn(url)({ prompt: "x", card: { id: "c1", project: null }, list: {} })
    );
    expect(body.routing ?? null).toBeNull();

    const noCard = await captureBody((url) => gatewayRunFn(url)({ prompt: "x", list: {} }));
    expect(noCard.routing ?? null).toBeNull();
  });

  it("the BATCH lane sends it too — a batch is grouped by project, so the group shares a cwd", async () => {
    const body = await captureBody((url) =>
      batchGatewayRunFn(url)({
        project: "ekoa-code",
        cards: [{ id: "c1", list: "test", sequence: ["test"], duty: "test", level: 1 }],
        list: { id: "test", executePrompt: "run tests", routerPrompt: "emit a verdict" },
        duty: "test",
        level: 1,
        phase: "test"
      })
    );
    expect(body.routing).toEqual({ project: "ekoa-code" });
  });

  it("the batch VERDICT NUDGE keeps the same cwd (it is the same session's follow-up)", async () => {
    const body = await captureBody((url) =>
      batchGatewayRunFn(url)({ project: "ekoa-code", cards: [], nudge: "just the verdict please", list: {} })
    );
    expect(body.routing).toEqual({ project: "ekoa-code" });
  });
});

describe("the gateway accepts that shape and turns it into a real cwd", () => {
  it("sanitizeRouting passes a project through the edge validator", () => {
    expect(sanitizeRouting({ project: "ekoa-code" }).routing).toEqual({ project: "ekoa-code" });
  });

  it("a resolvable project becomes the turn's projectPath", () => {
    const route = { targetId: "cc-sonnet", target: { runtime: "agent-sdk", model: "sonnet" } };
    const out = applyTurnOverride({}, route, { project: "ekoa-code" }, {
      resolveProject: (name: string) => (name === "ekoa-code" ? "/home/x/dev/ekoa-code" : null)
    });
    expect(out.projectPath).toBe("/home/x/dev/ekoa-code");
    expect(out.applied).toContain("project");
  });

  it("an UNRESOLVABLE project is refused, not silently run in the composition dir", () => {
    const route = { targetId: "cc-sonnet", target: { runtime: "agent-sdk", model: "sonnet" } };
    const out = applyTurnOverride({}, route, { project: "not-a-repo" }, { resolveProject: () => null });
    expect(out.projectPath).toBeNull();
    expect(out.rejected.map((r: any) => r.field)).toContain("project");
  });
});

// The rejection must reach the CARD, not just the gateway log. A turn that could not
// use the card's project ran somewhere else — the one thing that must never be silent.
describe("a refused project reaches the card and is rendered as a warning", () => {
  it("routeFromDone passes overridesApplied/overridesRejected through", () => {
    const r: any = routeFromDone({
      route: "cc-sonnet", model: "sonnet",
      overridesApplied: ["project"],
      overridesRejected: [{ field: "project", reason: "project-not-a-git-repo-under-dev-root" }]
    });
    expect(r.overridesApplied).toEqual(["project"]);
    expect(r.overridesRejected).toEqual([{ field: "project", reason: "project-not-a-git-repo-under-dev-root" }]);
  });

  it("routeStamp persists them onto the card", () => {
    const { route } = routeStamp(
      { model: "sonnet", project: "ekoa-code", overridesApplied: ["project"], overridesRejected: null },
      "code"
    );
    expect(route.project).toBe("ekoa-code");
    expect(route.overridesApplied).toEqual(["project"]);
  });

  it("a settled turn shows WHERE it ran", () => {
    const { badges } = execBadges({ model: "sonnet", project: "ekoa-code" } as any, null);
    expect(badges.find((b) => b.key === "project")?.value).toBe("ekoa-code");
  });

  it("a REFUSED project renders a loud badge saying the turn ran in the composition dir", () => {
    const { badges } = execBadges(
      { model: "sonnet", overridesRejected: [{ field: "project", reason: "project-not-a-git-repo-under-dev-root" }] } as any,
      null
    );
    const warn = badges.find((b) => b.key === "project-refused");
    expect(warn?.value).toBe("composition dir");
    expect(warn?.title).toMatch(/could not be used|composition directory/i);
  });

  it("does not claim a run location on a card that has not run yet", () => {
    const { badges, expected } = execBadges(null, { model: "sonnet", project: "ekoa-code" } as any);
    expect(expected).toBe(true);
    expect(badges.find((b) => b.key === "project")).toBeUndefined();
  });
});

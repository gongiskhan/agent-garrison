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
import { cardTurnRouting, gatewayRunFn, routeFromDone, projectNameForRouting } from "../fittings/seed/kanban-loop/lib/gateway-client.mjs";
// @ts-ignore pure mjs
import { PERSONAL_SCOPE_TOKEN } from "../fittings/seed/kanban-loop/lib/personal-workspace.mjs";
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

  it("routes a personal card with no project to the reserved personal scope", async () => {
    const body = await captureBody((url) =>
      gatewayRunFn(url)({
        prompt: "book the appointment",
        card: { id: "c-personal", scope: "personal", project: null },
        list: {}
      })
    );
    expect(body.routing).toEqual({ project: PERSONAL_SCOPE_TOKEN });
  });

  it("keeps explicit routing and a real project ahead of the personal fallback", () => {
    expect(cardTurnRouting({ scope: "personal", project: "garrison" })).toEqual({ project: "garrison" });
    expect(cardTurnRouting({ scope: "personal", routing: { project: "ekoa-code" } })).toEqual({ project: "ekoa-code" });
  });

  it("does not hide a specified but invalid project by substituting personal", () => {
    expect(cardTurnRouting({ scope: "personal", project: "/" })).toBeNull();
    expect(cardTurnRouting({ scope: "personal", routing: { project: ".." } })).toBeNull();
    expect(cardTurnRouting({ scope: "personal", routing: { project: "../ekoa-code" } })).toBeNull();
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

  it("the personal batch and its verdict nudge preserve the reserved scope", async () => {
    const body = await captureBody((url) =>
      batchGatewayRunFn(url)({
        project: PERSONAL_SCOPE_TOKEN,
        cards: [{ id: "c1", scope: "personal", list: "test", sequence: ["test"], duty: "test", level: 1 }],
        list: { id: "test", executePrompt: "run tests", routerPrompt: "emit a verdict" }
      })
    );
    expect(body.routing).toEqual({ project: PERSONAL_SCOPE_TOKEN });

    const nudge = await captureBody((url) =>
      batchGatewayRunFn(url)({ project: PERSONAL_SCOPE_TOKEN, cards: [], nudge: "verdict", list: {} })
    );
    expect(nudge.routing).toEqual({ project: PERSONAL_SCOPE_TOKEN });
  });

  it("an ordinary no-project batch does not send a fake cwd pin", async () => {
    const body = await captureBody((url) =>
      batchGatewayRunFn(url)({ project: "(no-project)", cards: [], nudge: "verdict", list: {} })
    );
    expect(body.routing ?? null).toBeNull();
  });
});

describe("the gateway accepts that shape and turns it into a real cwd", () => {
  it("sanitizeRouting passes a project through the edge validator", () => {
    expect(sanitizeRouting({ project: "ekoa-code" }).routing).toEqual({ project: "ekoa-code" });
    expect(sanitizeRouting({ project: PERSONAL_SCOPE_TOKEN }).routing).toEqual({ project: PERSONAL_SCOPE_TOKEN });
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

  it("a resolved personal token reports a friendly scope label and its real cwd", () => {
    const route = { targetId: "cc-sonnet", target: { runtime: "claude-code", model: "sonnet" } };
    const out = applyTurnOverride({}, route, { project: PERSONAL_SCOPE_TOKEN }, {
      resolveProject: (name: string) => name === PERSONAL_SCOPE_TOKEN ? "/home/x/.garrison/personal" : null
    });
    expect(out.project).toBe("personal");
    expect(out.projectPath).toBe("/home/x/.garrison/personal");
    expect(out.applied).toContain("project");
  });

  it("reports a personal-specific rejection when the fixed workspace is unavailable", () => {
    const route = { targetId: "cc-sonnet", target: { runtime: "claude-code", model: "sonnet" } };
    const out = applyTurnOverride({}, route, { project: PERSONAL_SCOPE_TOKEN }, { resolveProject: () => null });
    expect(out.rejected).toContainEqual({ field: "project", reason: "personal-workspace-unavailable" });
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

  it("a refused personal workspace renders personal remediation, not the git-repo rule", () => {
    const { badges } = execBadges(
      { model: "sonnet", overridesRejected: [{ field: "project", reason: "personal-workspace-unavailable" }] } as any,
      null
    );
    const warn = badges.find((b) => b.key === "project-refused");
    expect(warn?.label).toBe("scope");
    expect(warn?.value).toBe("refused");
    expect(warn?.title).toMatch(/turn was refused.*personal workspace.*kanban setup/i);
    expect(warn?.title).not.toMatch(/ran in the composition/i);
    expect(warn?.title).not.toMatch(/git repo/i);
  });

  it("does not claim a run location on a card that has not run yet", () => {
    const { badges, expected } = execBadges(null, { model: "sonnet", project: "ekoa-code" } as any);
    expect(expected).toBe(true);
    expect(badges.find((b) => b.key === "project")).toBeUndefined();
  });
});

// A card's `project` exists in TWO shapes in the wild — a bare slug and an absolute
// path — roughly half and half on a real board (7 of 18 cards were path-shaped when
// this was found by running the app). The gateway's resolver takes NAMES only, since
// a path could escape the dev root, so sending the raw value made every path-shaped
// card's project refused and its turn run in the composition directory.
describe("projectNameForRouting — both stored shapes of card.project resolve", () => {
  it("passes a bare slug through", () => {
    expect(projectNameForRouting("ekoa-code")).toBe("ekoa-code");
  });

  it("reduces an absolute path to its dev-root child name", () => {
    expect(projectNameForRouting("/home/ggomes/dev/ekoa-code")).toBe("ekoa-code");
    expect(projectNameForRouting("/home/ggomes/dev/garrison")).toBe("garrison");
  });

  it("tolerates a trailing slash and surrounding whitespace", () => {
    expect(projectNameForRouting("  /home/ggomes/dev/ekoa-code/  ")).toBe("ekoa-code");
  });

  it("refuses what the gateway would refuse anyway, rather than sending junk", () => {
    for (const bad of ["", "   ", null, undefined, "/", "..", ".", "/home/x/.hidden"]) {
      expect(projectNameForRouting(bad as any)).toBeNull();
    }
  });

  it("a path-shaped card actually dispatches a resolvable name", async () => {
    const body = await captureBody((url) =>
      gatewayRunFn(url)({
        prompt: "x",
        card: { id: "c1", project: "/home/ggomes/dev/ekoa-code" },
        list: {}
      })
    );
    expect(body.routing).toEqual({ project: "ekoa-code" });
  });
});

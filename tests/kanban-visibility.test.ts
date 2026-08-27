// V1d execution-visibility regression, trimmed by the Conversations cut.
//
// The original file pinned the list-driven run engine: buildCardPrompt told the
// operative what the card was, processCard/processBatch turned a reply into a
// list move, and every transition appended a timeline event. buildCardPrompt,
// processCard and processBatch are GONE — work now starts as a conversation via
// the gateway launcher, and sequencing lives in the stretch handoff, not in a
// reply's final line. What survives is what the timeline and inference are made
// of: the event ring (withEvent / replySnippet), the `created` event every card
// is seeded with, and project inference.
import { describe, it, expect, beforeAll, afterAll } from "vitest";

// S4: the run engine reads the compiled Orchestrator policy for gate-evidence
// enforcement + phase classification. These tests exercise the PURE transition
// mechanics, so pin the policy path at a nonexistent file (policy-less mode);
// the policy-driven behavior is covered in tests/run-engine.test.ts.
process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";
// S6 (D19): runDirs mint ABSOLUTE under the evidence home — sandbox it so
// tests never write the real ~/.garrison/runs.
import { mkdtempSync as __mkdtemp } from "node:fs";
import { tmpdir as __tmpdir } from "node:os";
import { join as __join } from "node:path";
process.env.GARRISON_RUNS_DIR = __mkdtemp(__join(__tmpdir(), "runs-home-"));

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — pure .mjs
import { withEvent, replySnippet } from "../fittings/seed/kanban-loop/lib/engine.mjs";
// @ts-ignore — pure .mjs
import { createCard } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore — pure .mjs
import { parseInferredProject, buildInferencePrompt, inferProject, explicitWorkspaceFromCard } from "../fittings/seed/kanban-loop/lib/infer-project.mjs";

// The card store is the STATE SERVICE now, not files under GARRISON_KANBAN_DIR.
// Boot one for this file and project its discovery env before anything reads a
// card; side files still live under the kanban root this file already pins.
import { setupKanbanState } from "./kanban-state-env";
let __kanbanState: Awaited<ReturnType<typeof setupKanbanState>>;
beforeAll(async () => {
  __kanbanState = await setupKanbanState();
}, 30_000);
afterAll(async () => {
  await __kanbanState?.stop();
});


const tmp = () => mkdtempSync(join(tmpdir(), "kanban-vis-"));

describe("V1d card timeline", () => {
  it("createCard seeds a 'created' event", async () => {
    const root = tmp();
    // `todo` is the default landing list under the five-state board (Backlog is gone).
    const card = await createCard(root, { title: "T", list: "todo" });
    expect(card.events[0].kind).toBe("created");
  });
});

describe("V1d withEvent / replySnippet", () => {
  it("withEvent appends and caps the timeline", () => {
    let card: any = { events: [] };
    for (let i = 0; i < 70; i++) card = { events: withEvent(card, { at: "t", kind: "x", message: String(i) }) };
    expect(card.events.length).toBeLessThanOrEqual(60);
    expect(card.events[card.events.length - 1].message).toBe("69");
  });
  it("replySnippet trims + truncates with an ellipsis", () => {
    expect(replySnippet("  hi  ")).toBe("hi");
    expect(replySnippet("x".repeat(400), 280).endsWith("…")).toBe(true);
    expect(replySnippet("")).toBe("");
  });
});

describe("V1d project inference — parse + injected runFn", () => {
  it("takes an explicitly named absolute workspace directly from the task", () => {
    expect(explicitWorkspaceFromCard({
      title: "Build a cache",
      description: "Implement the package in /tmp/cache-proof. Run its tests."
    })).toBe("/tmp/cache-proof");
    expect(explicitWorkspaceFromCard({ title: "Document https://example.test/tmp/cache" })).toBeNull();
    expect(explicitWorkspaceFromCard({ description: "Mention /tmp/cache as an incidental example" })).toBeNull();
  });
  it("parseInferredProject accepts a clean slug, rejects NONE / uncertainty / junk", () => {
    expect(parseInferredProject("ekoa")).toBe("ekoa");
    expect(parseInferredProject("blah\nproject: my-repo")).toBe("my-repo");
    expect(parseInferredProject("`ekoa-web`.")).toBe("ekoa-web");
    expect(parseInferredProject("ekoa\n[route: cc-opus]")).toBe("ekoa"); // ignores a trailing badge
    expect(parseInferredProject("NONE")).toBeNull();
    expect(parseInferredProject("I'm not sure")).toBeNull();
    expect(parseInferredProject("")).toBeNull();
  });
  it("buildInferencePrompt includes the title, description and known projects", () => {
    const p = buildInferencePrompt({ title: "Title", description: "Desc" }, ["alpha", "beta"]);
    expect(p).toContain("Title");
    expect(p).toContain("Desc");
    expect(p).toContain("alpha, beta");
  });
  it("inferProject returns the slug via an injected runFn", async () => {
    const r = await inferProject({ title: "x", description: "y" }, async () => ({ reply: "ekoa" }));
    expect(r.project).toBe("ekoa");
  });
});

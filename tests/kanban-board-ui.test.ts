// Unit tests for the kanban-loop own-port server's PURE handlers/helpers — no
// live socket. Covers the board-view builder (board + derived membership), the
// card-links resolver (the decision-10 pointers, incl. the transcript path via
// claudeProjectDirForCwd), and the path-confinement guard (traversal rejected).
// Hermetic: a tmpdir GARRISON_KANBAN_DIR and a sandbox project root.

import { describe, it, expect, beforeAll, afterAll } from "vitest";

// S4: the run engine reads the compiled Orchestrator policy for gate-evidence
// enforcement + phase classification. These tests exercise the PURE transition
// mechanics, so pin the policy path at a nonexistent file (policy-less mode);
// the policy-driven behavior is covered in tests/run-engine.test.ts.
process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";

import { promises as fs } from "node:fs";
import { realpathSync, symlinkSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// The server imports @garrison/claude-pty (paths helper). Point the transcript
// dir at a sandbox so the resolver is deterministic and never touches ~/.claude.
const TMP = path.join(os.tmpdir(), `kanban-ui-test-${process.pid}-${Date.now()}`);
const KANBAN_DIR = path.join(TMP, "kanban-loop");
const PROJECT_ROOT = path.join(TMP, "project");
const CLAUDE_PROJECTS = path.join(TMP, "claude-projects");

process.env.GARRISON_KANBAN_DIR = KANBAN_DIR;
process.env.GARRISON_KANBAN_PROJECT_ROOT = PROJECT_ROOT;
process.env.GARRISON_CLAUDE_PROJECTS_DIR = CLAUDE_PROJECTS;

// Imported AFTER the env is set so kanbanRoot()/claudeProjectsDir() pick it up.
// Both are plain ESM .mjs with no .d.ts; import via a non-literal specifier (the
// same convention as tests/claude-pty.test.ts) so tsc treats them as `any`
// rather than erroring on a missing declaration.
const SERVER = "../fittings/seed/kanban-loop/scripts/server.mjs";
const PTY_PKG = "@garrison/claude-pty";
const {
  buildBoardView,
  cardSummary,
  resolveCardLinks,
  resolveArtifactRef,
  confinePath,
  isValidCardId,
  isValidSliceId,
  isReadableFile
} = await import(SERVER);
const { claudeProjectDirForCwd } = await import(PTY_PKG);

beforeAll(async () => {
  await fs.mkdir(KANBAN_DIR, { recursive: true });
  await fs.mkdir(PROJECT_ROOT, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

// A trimmed board with one manual + one agent + one adversarial(codex) list.
function fakeBoard() {
  return {
    version: 2,
    lists: [
      { id: "backlog", title: "Backlog", order: 0, kind: "manual", trigger: "manual", validNext: ["todo"] },
      {
        id: "plan", title: "Plan", order: 1, kind: "agent", trigger: "immediate",
        phase: "plan", validNext: ["implement"]
      },
      {
        id: "adversarial-review", title: "Adversarial Review", order: 2, kind: "agent", trigger: "immediate",
        phase: "adversarial-review", validNext: ["test", "implement"]
      },
      { id: "done", title: "Done", order: 3, kind: "manual", trigger: "manual", terminal: true, validNext: [] }
    ]
  };
}

describe("buildBoardView", () => {
  it("derives membership from cards (never stored) and nests cards per list in order", () => {
    const board = fakeBoard();
    const cards = [
      { id: "A".repeat(26), title: "card a", list: "backlog", project: "pnm", iterations: 0, rev: 0 },
      { id: "B".repeat(26), title: "card b", list: "plan", project: "ekoa", iterations: 2, goalMode: true, rev: 1 },
      { id: "C".repeat(26), title: "card c", list: "plan", iterations: 0, rev: 0 }
    ];
    const view = buildBoardView(board, cards);

    // Lists are ordered by `order`.
    expect(view.lists.map((l: any) => l.id)).toEqual(["backlog", "plan", "adversarial-review", "done"]);

    const backlog = view.lists.find((l: any) => l.id === "backlog")!;
    const plan = view.lists.find((l: any) => l.id === "plan")!;
    const advReview = view.lists.find((l: any) => l.id === "adversarial-review")!;

    expect(backlog.cards.map((c: any) => c.id)).toEqual(["A".repeat(26)]);
    expect(plan.cards.map((c: any) => c.id)).toEqual(["B".repeat(26), "C".repeat(26)]);
    expect(advReview.cards).toEqual([]); // no card on it

    // The view carries the list's phase/trigger so the UI can render the column
    // (D15: no per-list skill — bindings live in the compiled policy).
    expect(plan.phase).toBe("plan");
    expect(plan.trigger).toBe("immediate");
    expect(advReview.phase).toBe("adversarial-review");
    expect(advReview.skill).toBeUndefined();

    // The flat array still carries every card.
    expect(view.cards).toHaveLength(3);
  });

  it("cardSummary projects the front fields + pointer set, not artifact bodies", () => {
    const card = {
      id: "Z".repeat(26),
      title: "t",
      project: "p",
      list: "plan",
      status: "running",
      iterations: 3,
      goalMode: true,
      rev: 5,
      runId: "RUN1",
      runDir: "docs/autothing/runs/RUN1",
      sliceId: "slice-x",
      sessionIds: ["sess-1"],
      briefPath: "briefs/x.md",
      videoUrl: "https://example/v",
      description: "a short description", // a front field (card tooltip + operative context)
      acceptance: "SHOULD NOT LEAK",
      events: [{
        at: "2026-07-16T08:00:00.000Z",
        kind: "runtime",
        message: "Plan runtime turn completed",
        route: {
          targetId: "sdk-sonnet-full",
          runtime: "agent-sdk",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          effort: "medium",
          effortApplied: true,
          phase: "plan"
        }
      }]
    };
    const s = cardSummary(card);
    expect(s).toMatchObject({
      id: "Z".repeat(26), title: "t", project: "p", list: "plan", status: "running",
      iterations: 3, goalMode: true, rev: 5, runId: "RUN1", sliceId: "slice-x",
      videoUrl: "https://example/v"
    });
    // description IS a deliberate front field (execution-visibility: the card tooltip +
    // operative context). The acceptance body, however, must NOT leak into the projection.
    expect((s as any).description).toBe("a short description");
    expect((s as any).acceptance).toBeUndefined();
    expect((s as any).lastRoute).toMatchObject({
      targetId: "sdk-sonnet-full",
      runtime: "agent-sdk",
      model: "claude-sonnet-4-6",
      effort: "medium",
      effortApplied: true,
      phase: "plan"
    });
  });
});

describe("resolveCardLinks", () => {
  it("resolves the decision-10 pointers, incl. the transcript path via claudeProjectDirForCwd", () => {
    const card = {
      id: "L".repeat(26),
      title: "linked",
      list: "implement",
      iterations: 2,
      runId: "RUNX",
      runDir: "docs/autothing/runs/RUNX",
      sliceId: "slice-1",
      sessionIds: ["abc-123", "def-456"],
      briefPath: "briefs/linked.md",
      videoUrl: "https://gallery/walkthrough.mp4"
    };
    const links = resolveCardLinks(card, { root: KANBAN_DIR, cwd: PROJECT_ROOT });

    // plan + gate markers are under the run dir, project-relative.
    expect(links.plan?.path).toBe(path.join(PROJECT_ROOT, "docs/autothing/runs/RUNX/FLOW_PLAN.md"));
    expect(links.gateMarkers?.path).toBe(
      path.join(PROJECT_ROOT, "docs/autothing/runs/RUNX/slices/slice-1/gate-status.json")
    );
    expect(links.brief?.path).toBe(path.join(PROJECT_ROOT, "briefs/linked.md"));

    // Sessions resolve to ~/.claude/projects/<encoded-cwd>/<id>.jsonl (sandboxed).
    const expectedDir = claudeProjectDirForCwd(PROJECT_ROOT);
    expect(links.sessions).toHaveLength(2);
    expect(links.sessions[0].path).toBe(path.join(expectedDir, "abc-123.jsonl"));
    expect(links.sessions[0].sessionId).toBe("abc-123");
    // The client-facing URL names the card + an OPAQUE ref token, NEVER a path.
    expect(links.sessions[0].url).toBe(`/cards/${"L".repeat(26)}/artifact?ref=session%3A0`);
    expect(links.sessions[0].url).not.toContain("?path=");
    expect(links.plan?.url).toBe(`/cards/${"L".repeat(26)}/artifact?ref=plan`);

    // Video is an external href, never proxied/duplicated (FINDING 8).
    expect(links.video).toEqual({ kind: "href", href: "https://gallery/walkthrough.mp4" });

    // Logs are the card's own per-iteration files under the board root.
    expect(links.logs).toHaveLength(2);
    expect(links.logs[0].path).toBe(path.join(KANBAN_DIR, "cards", "L".repeat(26), "log-1.md"));
  });

  it("marks pointers absent when the card has no run yet", () => {
    const card = { id: "N".repeat(26), title: "new", list: "backlog", iterations: 0, sessionIds: [] };
    const links = resolveCardLinks(card, { root: KANBAN_DIR, cwd: PROJECT_ROOT });
    expect(links.plan).toBeNull();
    expect(links.gateMarkers).toBeNull();
    expect(links.gates).toEqual([]);
    expect(links.brief).toBeNull();
    expect(links.video).toBeNull();
    expect(links.sessions).toEqual([]);
    expect(links.logs).toEqual([]);
  });

  it("exists reflects the file actually being on disk", async () => {
    const card = {
      id: "E".repeat(26), title: "e", list: "plan", iterations: 1,
      runId: "R", runDir: "docs/autothing/runs/R", sessionIds: []
    };
    // First: nothing on disk.
    let links = resolveCardLinks(card, { root: KANBAN_DIR, cwd: PROJECT_ROOT });
    expect(links.plan?.exists).toBe(false);
    // Write the plan, re-resolve.
    const planPath = path.join(PROJECT_ROOT, "docs/autothing/runs/R/FLOW_PLAN.md");
    await fs.mkdir(path.dirname(planPath), { recursive: true });
    await fs.writeFile(planPath, "# plan", "utf8");
    links = resolveCardLinks(card, { root: KANBAN_DIR, cwd: PROJECT_ROOT });
    expect(links.plan?.exists).toBe(true);
  });

  it("falls back to plan.md and enumerates safe phase gates in workflow order", async () => {
    const runRel = "docs/autothing/runs/R-GATES";
    const runDir = path.join(PROJECT_ROOT, runRel);
    await fs.mkdir(path.join(runDir, "gate-status.review.json"), { recursive: true }); // directory: ignored
    await fs.writeFile(path.join(runDir, "plan.md"), "# runtime plan", "utf8");
    await fs.writeFile(path.join(runDir, "gate-status.implement.json"), "{}", "utf8");
    await fs.writeFile(path.join(runDir, "gate-status.plan.json"), "{}", "utf8");
    await fs.writeFile(path.join(runDir, "gate-status.json"), "{}", "utf8");
    await fs.writeFile(path.join(runDir, "gate-status.plan.json.bak"), "ignored", "utf8");
    const card = {
      id: "G".repeat(26),
      title: "gates",
      list: "implement",
      iterations: 1,
      runDir: runRel,
      sequence: ["plan", "implement", "review", "test"],
      sessionIds: []
    };

    let links = resolveCardLinks(card, { root: KANBAN_DIR, cwd: PROJECT_ROOT });
    expect(links.plan?.path).toBe(path.join(runDir, "plan.md"));
    expect(links.plan?.exists).toBe(true);
    expect(links.gates.map((g: any) => path.basename(g.path))).toEqual([
      "gate-status.plan.json",
      "gate-status.implement.json",
      "gate-status.json"
    ]);
    expect(links.gates.every((g: any) => g.url.includes("artifact?ref=gate%3A"))).toBe(true);
    expect(resolveArtifactRef(card, "gate:gate-status.plan.json", { root: KANBAN_DIR, cwd: PROJECT_ROOT }))
      .toBe(path.join(runDir, "gate-status.plan.json"));
    expect(resolveArtifactRef(card, "gate:../secret.json", { root: KANBAN_DIR, cwd: PROJECT_ROOT })).toBeNull();

    await fs.writeFile(path.join(runDir, "FLOW_PLAN.md"), "# canonical plan", "utf8");
    links = resolveCardLinks(card, { root: KANBAN_DIR, cwd: PROJECT_ROOT });
    expect(links.plan?.path).toBe(path.join(runDir, "FLOW_PLAN.md"));
  });
});

describe("confinePath (path-confinement guard)", () => {
  const roots = [PROJECT_ROOT, KANBAN_DIR];

  // confinePath now canonicalizes through symlinks (realpath), so compare against
  // the realpath of the existing root + the relative tail (on macOS os.tmpdir() is
  // under /var → /private/var, so a raw path.resolve would not match).
  it("accepts a path inside an allowed root", () => {
    const rel = "docs/autothing/runs/R/FLOW_PLAN.md";
    const inside = path.join(PROJECT_ROOT, rel);
    expect(confinePath(inside, roots)).toBe(path.join(realpathSync(PROJECT_ROOT), rel));
  });

  it("accepts a path inside the board root", () => {
    const rel = path.join("cards", "X".repeat(26), "log-1.md");
    const inside = path.join(KANBAN_DIR, rel);
    expect(confinePath(inside, roots)).toBe(path.join(realpathSync(KANBAN_DIR), rel));
  });

  it("rejects a traversal escape with ..", () => {
    const escape = path.join(PROJECT_ROOT, "..", "..", "etc", "passwd");
    expect(confinePath(escape, roots)).toBeNull();
  });

  it("rejects an absolute path outside every root", () => {
    expect(confinePath("/etc/passwd", roots)).toBeNull();
    expect(confinePath(path.join(os.homedir(), ".ssh", "id_rsa"), roots)).toBeNull();
  });

  it("rejects a sibling-prefix near-match (root /a/bc must not pass /a/bcd)", () => {
    const sibling = `${PROJECT_ROOT}-evil/secret`;
    expect(confinePath(sibling, roots)).toBeNull();
  });

  it("rejects non-string / empty input", () => {
    expect(confinePath(null as any, roots)).toBeNull();
    expect(confinePath("", roots)).toBeNull();
  });

  it("rejects a SYMLINK inside a root that points OUTSIDE it (realpath canonicalization)", () => {
    const secret = path.join(TMP, "outside-secret.txt");
    writeFileSync(secret, "TOP SECRET", "utf8");
    const linkDir = path.join(PROJECT_ROOT, "links");
    mkdirSync(linkDir, { recursive: true });
    const link = path.join(linkDir, "escape.txt");
    try { symlinkSync(secret, link); } catch { /* symlink may be unsupported — skip */ }
    // The link path is lexically inside PROJECT_ROOT, but realpath resolves it to
    // the outside secret, so confinePath must reject it.
    const narrowRoots = [PROJECT_ROOT];
    expect(confinePath(link, narrowRoots)).toBeNull();
  });
});

describe("resolveArtifactRef (server-side ref → path; client never supplies a path)", () => {
  const card = {
    id: "M".repeat(26), title: "m", list: "implement", iterations: 2,
    runId: "RZ", runDir: "docs/autothing/runs/RZ", sliceId: "s1",
    sessionIds: ["sess-a", "sess-b"], briefPath: "briefs/m.md"
  };
  const opts = { root: KANBAN_DIR, cwd: PROJECT_ROOT };

  it("derives each known ref from the card's OWN pointers (card-scoped)", () => {
    expect(resolveArtifactRef(card, "plan", opts)).toBe(path.join(PROJECT_ROOT, "docs/autothing/runs/RZ/FLOW_PLAN.md"));
    // evidenceIndex is CARD-SCOPED — under this card's own run dir, not the shared global.
    expect(resolveArtifactRef(card, "evidenceIndex", opts)).toBe(path.join(PROJECT_ROOT, "docs/autothing/runs/RZ/evidence-index.json"));
    expect(resolveArtifactRef(card, "gateMarkers", opts)).toBe(path.join(PROJECT_ROOT, "docs/autothing/runs/RZ/slices/s1/gate-status.json"));
    expect(resolveArtifactRef(card, "gate:gate-status.plan.json", opts)).toBe(path.join(PROJECT_ROOT, "docs/autothing/runs/RZ/gate-status.plan.json"));
    expect(resolveArtifactRef(card, "brief", opts)).toBe(path.join(PROJECT_ROOT, "briefs/m.md"));
    expect(resolveArtifactRef(card, "session:1", opts)).toBe(path.join(claudeProjectDirForCwd(PROJECT_ROOT), "sess-b.jsonl"));
    expect(resolveArtifactRef(card, "log:2", opts)).toBe(path.join(KANBAN_DIR, "cards", "M".repeat(26), "log-2.md"));
  });

  it("returns null for unknown / out-of-range / malicious refs (no arbitrary path)", () => {
    expect(resolveArtifactRef(card, "../../etc/passwd", opts)).toBeNull();
    expect(resolveArtifactRef(card, "/etc/passwd", opts)).toBeNull();
    expect(resolveArtifactRef(card, "session:9", opts)).toBeNull();   // out of range
    expect(resolveArtifactRef(card, "log:99", opts)).toBeNull();      // beyond iterations
    expect(resolveArtifactRef(card, "log:0", opts)).toBeNull();       // logs are 1-based
    expect(resolveArtifactRef(card, "nonsense", opts)).toBeNull();
    expect(resolveArtifactRef({ id: "x", iterations: 0 }, "plan", opts)).toBeNull(); // no runDir
  });

  it("a path-steering sliceId cannot escape the run dir for gateMarkers", () => {
    expect(resolveArtifactRef({ ...card, sliceId: "../../../etc" }, "gateMarkers", opts)).toBeNull();
    expect(resolveArtifactRef({ ...card, sliceId: "a/b" }, "gateMarkers", opts)).toBeNull();
    expect(resolveArtifactRef({ ...card, sliceId: ".." }, "gateMarkers", opts)).toBeNull();
    // a clean slice id still resolves
    expect(resolveArtifactRef({ ...card, sliceId: "slice_2" }, "gateMarkers", opts))
      .toBe(path.join(PROJECT_ROOT, "docs/autothing/runs/RZ/slices/slice_2/gate-status.json"));
  });
});

describe("isValidSliceId (PATCH guard against path-steering)", () => {
  it("accepts clean slice ids, rejects separators / .. / empty", () => {
    expect(isValidSliceId("s1")).toBe(true);
    expect(isValidSliceId("slice-2.a_b")).toBe(true);
    expect(isValidSliceId("a/b")).toBe(false);
    expect(isValidSliceId("../x")).toBe(false);
    expect(isValidSliceId("..")).toBe(false);
    expect(isValidSliceId("")).toBe(false);
    expect(isValidSliceId(null as any)).toBe(false);
  });
});

describe("isValidCardId (router guard against traversal via :id)", () => {
  it("accepts a clean ULID", () => {
    expect(isValidCardId("A".repeat(26))).toBe(true);
    expect(isValidCardId("01KVX7G59RE5B12BZ1T3GHXVYF")).toBe(true);
  });
  it("rejects traversal / separators / wrong length / non-string", () => {
    expect(isValidCardId("../../etc/passwd")).toBe(false);
    expect(isValidCardId("../../../secret")).toBe(false);
    expect(isValidCardId("a/b")).toBe(false);
    expect(isValidCardId("A".repeat(25))).toBe(false); // too short
    expect(isValidCardId("A".repeat(27))).toBe(false); // too long
    expect(isValidCardId("ILOU".padEnd(26, "0"))).toBe(false); // excluded letters
    expect(isValidCardId("")).toBe(false);
    expect(isValidCardId(null as any)).toBe(false);
  });
});

describe("isReadableFile", () => {
  it("true for a real file, false for a directory and a missing path", async () => {
    const f = path.join(TMP, "real.txt");
    await fs.writeFile(f, "x", "utf8");
    expect(isReadableFile(f)).toBe(true);
    expect(isReadableFile(TMP)).toBe(false); // a directory
    expect(isReadableFile(path.join(TMP, "nope.txt"))).toBe(false);
  });
});

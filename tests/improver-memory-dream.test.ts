import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — pure .mjs
import { findDuplicateNotes, scanRelativeDates, selectStaleCheckpoints, buildDreamProposals, runDreamPhase } from "../fittings/seed/improver/lib/memory-dream.mjs";
// @ts-ignore — pure .mjs
import { computeDream } from "../fittings/seed/improver/scripts/improver.mjs";

const NOW = "2026-06-20T12:00:00Z";
const DAY = 24 * 60 * 60 * 1000;

describe("dream — pure scans", () => {
  it("findDuplicateNotes groups same-title and near-identical-content notes", () => {
    const notes = [
      { path: "a.md", title: "Deploy runbook", content: "step one build step two ship step three verify the release" },
      { path: "b.md", title: "Deploy Runbook!", content: "totally different words about cooking pasta and sauce" },
      { path: "c.md", title: "Unrelated", content: "step one build step two ship step three verify the release now" },
      { path: "d.md", title: "Lonely", content: "nothing in common with any other note here at all whatsoever" },
    ];
    const groups = findDuplicateNotes(notes);
    // a~b by title, a~c by content → one transitive group {a,b,c}; d alone.
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("scanRelativeDates flags body lines, skipping frontmatter and code blocks", () => {
    const notes = [
      {
        path: "n.md",
        title: "N",
        content:
          "---\ndate: 2026-06-20\ntitle: yesterday in frontmatter ignored\n---\n" +
          "We shipped this yesterday.\n" +
          "```\nthis yesterday is in a code block\n```\n" +
          "Absolute: shipped on 2026-06-19 only.\n" +
          "Will revisit next week.\n",
      },
    ];
    const hits = scanRelativeDates(notes);
    const lines = hits.map((h: any) => h.line);
    expect(lines).toContain("We shipped this yesterday.");
    expect(lines).toContain("Will revisit next week.");
    expect(lines.some((l: string) => l.includes("code block"))).toBe(false);
    expect(lines.some((l: string) => l.includes("frontmatter"))).toBe(false);
    expect(lines.some((l: string) => l === "Absolute: shipped on 2026-06-19 only.")).toBe(false);
  });

  it("selectStaleCheckpoints only picks old session-*.md", () => {
    const nowMs = new Date(NOW).getTime();
    const files = [
      { name: "session-old.md", path: "Memory/session-old.md", mtimeMs: nowMs - 20 * DAY },
      { name: "session-fresh.md", path: "Memory/session-fresh.md", mtimeMs: nowMs - 2 * DAY },
      { name: "durable.md", path: "Memory/durable.md", mtimeMs: nowMs - 90 * DAY },
    ];
    const stale = selectStaleCheckpoints(files, { now: NOW, retentionDays: 14 });
    expect(stale.map((f: any) => f.path)).toEqual(["Memory/session-old.md"]);
  });
});

describe("dream — proposal builder (anti-hallucination + cap)", () => {
  const known = ["Memory/a.md", "Memory/b.md"];
  it("drops items citing a path not in the vault; keeps valid ones; shapes rule memory-dream", () => {
    const items = [
      { kind: "merge", sources: ["Memory/a.md", "Memory/b.md"], title: "Merge", claim: "dup", body: "# Merged\nx" },
      { kind: "date-fix", sources: ["Memory/ghost.md"], title: "Ghost", claim: "bad", body: "y" },
      { kind: "frobnicate", sources: ["Memory/a.md"], title: "Bad kind", claim: "z", body: "z" },
      { kind: "prune", sources: ["Memory/a.md"], title: "Prune", claim: "stale", body: "" },
    ];
    const { proposals, dropped } = buildDreamProposals({ items, knownPaths: known, at: NOW });
    expect(proposals).toHaveLength(1);
    const p = proposals[0];
    expect(p.rule).toBe("memory-dream");
    expect(p.targetClass).toBe("memory/vault");
    expect(p.evidence.sources).toEqual(["Memory/a.md", "Memory/b.md"]);
    expect(p.diff).toContain("+# Merged");
    expect(dropped.some((d: any) => d.reason === "fabricated-source")).toBe(true);
    expect(dropped.some((d: any) => d.reason === "bad-kind")).toBe(true);
    expect(dropped.some((d: any) => d.reason === "empty-body")).toBe(true);
  });

  it("enforces the cap", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      kind: "distill",
      sources: ["Memory/a.md"],
      title: `T${i}`,
      claim: `c${i}`,
      body: `body ${i}`,
    }));
    const { proposals } = buildDreamProposals({ items, knownPaths: known, cap: 3, at: NOW });
    expect(proposals).toHaveLength(3);
  });
});

describe("dream — runDreamPhase orchestrator (hermetic)", () => {
  function seedVault() {
    const vault = mkdtempSync(join(tmpdir(), "dream-vault-"));
    const mem = join(vault, "Memory");
    mkdirSync(mem, { recursive: true });
    // two near-duplicate durable notes
    writeFileSync(join(mem, "dup-a.md"), "---\ntitle: Garrison cost\n---\n# Garrison cost\nidle operative costs zero tokens only turns spend usage\n");
    writeFileSync(join(mem, "dup-b.md"), "---\ntitle: Garrison cost\n---\n# Garrison cost\nidle operative costs zero tokens only turns spend usage budget\n");
    // a relative-date note
    writeFileSync(join(mem, "relative.md"), "---\ntitle: Deploy\n---\n# Deploy\nWe shipped the migration yesterday.\n");
    // an old session checkpoint (to be archived) + a fresh one (kept)
    const oldCp = join(mem, "session-20260101-000000-deadbeef.md");
    writeFileSync(oldCp, "---\ntitle: old checkpoint\n---\n# old\nstuff\n");
    const freshCp = join(mem, "session-20260620-000000-cafef00d.md");
    writeFileSync(freshCp, "---\ntitle: fresh checkpoint\n---\n# fresh\nrecent stuff to distill\n");
    const nowMs = new Date(NOW).getTime();
    utimesSync(oldCp, new Date(nowMs - 30 * DAY), new Date(nowMs - 30 * DAY));
    utimesSync(freshCp, new Date(nowMs - 2 * 60 * 60 * 1000), new Date(nowMs - 2 * 60 * 60 * 1000));
    return { vault, mem, oldCp };
  }

  it("archives stale checkpoints (auto) and returns source-cited consolidation proposals", async () => {
    const { vault, mem } = seedVault();
    const reply = JSON.stringify({
      proposals: [
        { kind: "merge", sources: ["Memory/dup-a.md", "Memory/dup-b.md"], title: "Merge cost notes", claim: "same memory twice", body: "# Garrison cost\nidle = $0; only turns spend." },
        { kind: "date-fix", sources: ["Memory/relative.md"], title: "Absolutize", claim: "yesterday -> date", body: "We shipped the migration on 2026-06-19." },
        { kind: "merge", sources: ["Memory/does-not-exist.md"], title: "Ghost", claim: "hallucinated", body: "nope" },
      ],
    });
    const runTurn = async () => ({ reply, sessionId: "t" });

    const res = await runDreamPhase({
      vaultDir: vault,
      retentionDays: 14,
      runTurn,
      runCommand: null, // skip basic-memory reindex/doctor
      now: NOW,
    });

    // housekeeping auto-applied: the old checkpoint moved into Memory/archive/
    expect(res.housekeeping.archived).toContain("Memory/session-20260101-000000-deadbeef.md");
    expect(existsSync(join(mem, "archive", "session-20260101-000000-deadbeef.md"))).toBe(true);
    expect(existsSync(join(mem, "session-20260101-000000-deadbeef.md"))).toBe(false);
    // fresh checkpoint untouched
    expect(existsSync(join(mem, "session-20260620-000000-cafef00d.md"))).toBe(true);

    // consolidation proposals: the two real-path items survive, the ghost is dropped
    const kinds = res.dreamProposals.map((p: any) => p.evidence.kind).sort();
    expect(kinds).toEqual(["date-fix", "merge"]);
    expect(res.dreamProposals.every((p: any) => p.rule === "memory-dream")).toBe(true);
    expect(res.dropped.some((d: any) => d.reason === "fabricated-source")).toBe(true);
  });
});

describe("dream — computeDream gate (memory_primary)", () => {
  // Isolate IMPROVER_DATA to a fresh empty dir so loadDreamConfig never reads a
  // real ~/.garrison/improver/dream-config.json on the dev machine. The gate is
  // then driven purely by env, and a non-primary run must NOT touch the PTY.
  const ENV_KEYS = ["IMPROVER_MEMORY_PRIMARY", "IMPROVER_VAULT_DIR", "IMPROVER_DREAM_NO_INDEX", "IMPROVER_DREAM_FIXTURE", "IMPROVER_DATA"];

  it("returns no proposals and a skip reason when not memory_primary", async () => {
    const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.IMPROVER_DATA = mkdtempSync(join(tmpdir(), "dream-data-"));
    try {
      const r = await computeDream({ now: NOW });
      expect(r.dreamProposals).toEqual([]);
      expect(r.housekeeping.skipped).toBe("not memory_primary");
    } finally {
      for (const k of ENV_KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
    }
  });

  it("runs the dream phase when memory_primary + vault are set (fixture-replayed PTY)", async () => {
    const vault = mkdtempSync(join(tmpdir(), "dream-cd-"));
    mkdirSync(join(vault, "Memory"), { recursive: true });
    writeFileSync(join(vault, "Memory", "x.md"), "---\ntitle: X\n---\n# X\nWe did this yesterday and last week.\n");
    const fixture = join(vault, "fixture.json");
    writeFileSync(
      fixture,
      JSON.stringify({
        reply: JSON.stringify({
          proposals: [{ kind: "date-fix", sources: ["Memory/x.md"], title: "Fix", claim: "abs", body: "We did this on 2026-06-19 and the week of 2026-06-09." }],
        }),
      })
    );
    const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    Object.assign(process.env, {
      IMPROVER_MEMORY_PRIMARY: "1",
      IMPROVER_VAULT_DIR: vault,
      IMPROVER_DREAM_NO_INDEX: "1",
      IMPROVER_DREAM_FIXTURE: fixture,
      IMPROVER_DATA: mkdtempSync(join(tmpdir(), "dream-data-")),
    });
    try {
      const r = await computeDream({ now: NOW });
      expect(r.dreamProposals).toHaveLength(1);
      expect(r.dreamProposals[0].rule).toBe("memory-dream");
      expect(r.dreamProposals[0].evidence.sources).toEqual(["Memory/x.md"]);
    } finally {
      for (const k of ENV_KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
    }
  });
});

describe("dream — CLI: survives the skills phase early-exit", () => {
  const CLI = join(__dirname, "..", "fittings", "seed", "improver", "scripts", "improver.mjs");

  it("persists dream proposals even when the skills phase exits non-zero (no skills/telemetry)", () => {
    const root = mkdtempSync(join(tmpdir(), "dream-early-"));
    const data = join(root, "data");
    const projects = join(root, "projects"); // empty → no telemetry
    const claudeHome = join(root, "claude");
    const vault = join(root, "vault");
    mkdirSync(data, { recursive: true });
    mkdirSync(projects, { recursive: true });
    mkdirSync(join(claudeHome, "skills"), { recursive: true }); // no skills → skills phase exits early
    mkdirSync(join(vault, "Memory"), { recursive: true });
    writeFileSync(join(vault, "Memory", "a.md"), "---\ntitle: Dup\n---\n# Dup\nidentical body for duplicate detection here\n");
    writeFileSync(join(vault, "Memory", "b.md"), "---\ntitle: Dup\n---\n# Dup\nidentical body for duplicate detection here too\n");
    const fixture = join(root, "fix.json");
    writeFileSync(
      fixture,
      JSON.stringify({ reply: JSON.stringify({ proposals: [{ kind: "merge", sources: ["Memory/a.md", "Memory/b.md"], title: "M", claim: "dup", body: "# Merged\nx" }] }) })
    );

    let exit = 0;
    try {
      execFileSync("node", [CLI, "run-now", "improver-nightly"], {
        encoding: "utf8",
        env: {
          ...process.env,
          IMPROVER_PROJECTS_DIR: projects, // activates the skills two-phase path
          GARRISON_CLAUDE_HOME: claudeHome,
          IMPROVER_DATA: data,
          IMPROVER_MEMORY: join(root, "no-memory.md"), // absent → no memory-consolidation noise
          IMPROVER_MEMORY_PRIMARY: "1",
          IMPROVER_VAULT_DIR: vault,
          IMPROVER_DREAM_FIXTURE: fixture,
          IMPROVER_DREAM_NO_INDEX: "1",
        },
      });
    } catch (e: any) {
      exit = e.status ?? 1;
    }

    expect(exit).not.toBe(0); // the skills phase exits early (no loose skill to prove FINDING 2)
    const queue = JSON.parse(readFileSync(join(data, "review-queue.json"), "utf8"));
    expect(queue.some((p: any) => p.rule === "memory-dream")).toBe(true); // dream still persisted
  });
});

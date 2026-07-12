import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseGarrisonMetadata } from "@/lib/metadata";
import { readYamlFile } from "@/lib/yaml";

// The fitting ships as pure .mjs (runs under plain node); import via absolute path.
const FIT = path.resolve(__dirname, "..", "fittings", "seed", "garrison-assistant");
// eslint-disable-next-line
const importMjs = (rel: string): Promise<any> => import(path.join(FIT, rel));

const REPO_ROOT = path.resolve(__dirname, "..");

describe("garrison-assistant Fitting", () => {
  it("manifest parses as a sessions own-port Fitting consuming memory-store optionally", async () => {
    const manifest = await readYamlFile<{ "x-garrison"?: unknown }>(path.join(FIT, "apm.yml"));
    const m = parseGarrisonMetadata(manifest!["x-garrison"]);
    expect(m.faculty).toBe("sessions");
    expect(m.own_port).toBe(true);
    expect(m.consumes).toContainEqual({ kind: "memory-store", cardinality: "optional-one" });
    expect(m.verify?.command).toContain("--probe");
  });
});

describe("Answer mode grounds answers in real sources", () => {
  it("answers three questions, each citing real source files", async () => {
    const { buildIndex, answer } = await importMjs("lib/index-store.mjs");
    const index = buildIndex({ repoRoot: REPO_ROOT });
    expect(index.size).toBeGreaterThan(20);

    const cases = [
      { q: "what is the runtimes faculty", must: /FACULTIES|runtime/i },
      { q: "how do I use the taste Fitting", must: /taste/i },
      { q: "how does composition switching work", must: /composition|switch/i }
    ];
    for (const c of cases) {
      const a = answer(index, c.q);
      expect(a.sources.length, `${c.q} → sources`).toBeGreaterThan(0);
      // every cited source is a real repo file path
      for (const src of a.sources) {
        expect(() => readFileSync(path.join(REPO_ROOT, src), "utf8")).not.toThrow();
      }
      expect(a.answer).toMatch(c.must);
    }
  });
});

describe("Guide mode launches tours by name", () => {
  it("resolves a known tour to a launch directive and fails loud on unknown", async () => {
    const { launchTour } = await importMjs("lib/tours.mjs");
    const launch = launchTour("switch-composition");
    expect(launch.launch).toBe(true);
    expect(launch.name).toBe("switch-composition");
    expect(launch.url).toContain("tour=switch-composition");
    expect(() => launchTour("does-not-exist")).toThrow(/unknown tour/);
  });
});

describe("Build interview is adaptive and files provenance-assistant proposals", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), "gassist-"));
    process.env.IMPROVER_DATA = dataDir;
  });
  afterEach(() => {
    delete process.env.IMPROVER_DATA;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("asks >=4 questions, adapts to answers, then files a skill + an automation proposal", async () => {
    const { nextStep } = await importMjs("lib/interview.mjs");
    const { fileProposals } = await importMjs("lib/proposals.mjs");

    const answers: Array<{ id: string; text: string }> = [];
    const asked: string[] = [];
    let filed: Array<{ provenance: string; targetClass: string }> = [];
    for (let i = 0; i < 8; i++) {
      const step = nextStep(answers);
      if (step.done) {
        filed = fileProposals(step.proposals, "2026-07-12T20:30:00Z");
        break;
      }
      asked.push(step.question.id);
      const map: Record<string, string> = {
        daily: "run the test suite and review diffs",
        byhand: "ran lint and tests manually before every commit",
        repeat: "pull, install, typecheck, test, commit",
        byhand_detail: "on every commit"
      };
      answers.push({ id: step.question.id, text: map[step.question.id] ?? "x" });
    }

    expect(asked.length).toBeGreaterThanOrEqual(4);
    // adaptive: the byhand="lint and tests" answer branches to the CI-specific follow-up
    expect(asked).toContain("byhand_detail");

    expect(filed.length).toBe(2);
    expect(filed.every((p) => p.provenance === "assistant")).toBe(true);
    expect(filed.map((p) => p.targetClass)).toContain("quarters/skill");
    expect(filed.map((p) => p.targetClass)).toContain("automations/job");

    // the proposals landed in the Improver review-queue.json the UI reads
    const queue = JSON.parse(readFileSync(path.join(dataDir, "review-queue.json"), "utf8"));
    expect(queue.filter((p: { provenance?: string }) => p.provenance === "assistant").length).toBe(2);
    expect(queue.every((p: { status?: string }) => p.status === "pending")).toBe(true);
  });

  it("adapts differently for a non-CI by-hand answer", async () => {
    const { nextStep } = await importMjs("lib/interview.mjs");
    const answers = [
      { id: "daily", text: "write the weekly status report" },
      { id: "byhand", text: "wrote the status summary for the team" },
      { id: "repeat", text: "collect, summarize, send" }
    ];
    const step = nextStep(answers);
    expect(step.done).toBe(false);
    expect(step.question.id).toBe("byhand_detail");
    expect(step.question.q).toMatch(/report|reads it/i);
  });
});

describe("hardening (S5 codex findings)", () => {
  it("I2: the index never follows a symlink out of the repo", async () => {
    const { buildIndex } = await importMjs("lib/index-store.mjs");
    const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } = await import("node:fs");
    const os = await import("node:os");
    const p = await import("node:path");
    const root = mkdtempSync(p.join(os.tmpdir(), "idx-"));
    mkdirSync(p.join(root, "docs"));
    mkdirSync(p.join(root, "fittings", "seed"), { recursive: true });
    writeFileSync(p.join(root, "docs", "real.md"), "# Real\nlegit content here indexed");
    const secret = p.join(root, "SECRET.md");
    writeFileSync(secret, "# secret\ntoken sekritvalue leak");
    try { symlinkSync(secret, p.join(root, "docs", "leak.md")); } catch { /* platform w/o symlink */ }
    const index = buildIndex({ repoRoot: root });
    const joined = index.records.map((r: {source:string}) => r.source).join("|");
    expect(joined).toContain("docs/real.md");
    expect(joined).not.toContain("leak.md"); // the symlink was skipped
    expect(index.records.some((r: {body:string}) => /sekritvalue/.test(r.body))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("I5: fileProposals refuses to overwrite a corrupt queue (never data-loss)", async () => {
    const { fileProposals } = await importMjs("lib/proposals.mjs");
    const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
    const os = await import("node:os");
    const p = await import("node:path");
    const dir = mkdtempSync(p.join(os.tmpdir(), "q-"));
    process.env.IMPROVER_DATA = dir;
    const qf = p.join(dir, "review-queue.json");
    writeFileSync(qf, "{ this is not json");
    const candidate = { kind: "skill", targetClass: "quarters/skill", title: "x", claim: "x", draft: { name: "x" } };
    expect(() => fileProposals([candidate], "2026-07-12T00:00:00Z")).toThrow(/refusing to overwrite/);
    // the corrupt file is untouched (not clobbered)
    expect(readFileSync(qf, "utf8")).toBe("{ this is not json");
    delete process.env.IMPROVER_DATA;
  });
});

describe("I4: malformed interview input is a 400, never an uncaught 500", () => {
  it("rejects a non-array and a bad element with 400", async () => {
    const { createServer } = await importMjs("scripts/server.mjs");
    const http = await import("node:http");
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;

    const post = (body: string): Promise<number> =>
      new Promise((resolve) => {
        const req = http.request(
          { host: "127.0.0.1", port, path: "/interview/next", method: "POST", headers: { "content-type": "application/json" } },
          (res) => { res.resume(); resolve(res.statusCode ?? 0); }
        );
        req.end(body);
      });

    expect(await post('{"answers":[null]}')).toBe(400);
    expect(await post('{"answers":"x"}')).toBe(400);
    expect(await post('{"answers":[]}')).toBe(200); // valid empty → first question
    await new Promise<void>((r) => server.close(() => r()));
  });
});

import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { placeOrchestratedSession, resolvePlacementMode, safeComposition, resolvePlacementPaths } from "../src/lib/orchestrator-placement";
// The `modes` seed fitting was retired (S3f2b); placeOrchestratedSession is still-live
// code, so it is driven against a synthetic modes fixture instead of the removed seed.
import { writeModesFixture } from "./helpers/modes-fixture";

const ROOT = join(__dirname, "..");
const MODES_DIR = writeModesFixture(mkdtempSync(join(tmpdir(), "place-modes-fx-")));
const RCONF = join(ROOT, "fittings/seed/orchestrator/config/routing.seed.json");
const NAMES = ["gary", "joe", "james"];
const CH = { "dev-env": "joe", slack: "gary", web: "gary" };

const place = (channel: string, mode?: string) =>
  placeOrchestratedSession({
    channel,
    mode,
    modesDir: MODES_DIR,
    routingConfigPath: RCONF,
    outDir: mkdtempSync(join(tmpdir(), "place-"))
  });

describe("orchestrator placement (s3a)", () => {
  it("resolvePlacementMode: explicit wins, else channel default, else default", () => {
    expect(resolvePlacementMode("dev-env", null, NAMES, CH, "gary")).toBe("joe");
    expect(resolvePlacementMode("slack", null, NAMES, CH, "gary")).toBe("gary");
    expect(resolvePlacementMode("dev-env", "james", NAMES, CH, "gary")).toBe("james");
    expect(resolvePlacementMode("sms", null, NAMES, CH, "gary")).toBe("gary"); // unknown channel → default
    expect(resolvePlacementMode("dev-env", "bogus", NAMES, CH, "gary")).toBe("joe"); // invalid explicit → channel default
  });

  it("dev-env channel places Joe (the dev face) at the expert→opus tier", async () => {
    const r = await place("dev-env");
    expect(r).not.toBeNull();
    expect(r!.mode).toBe("joe");
    expect(r!.role).toBe("expert");
    expect(r!.model).toBe("opus"); // balanced roleMap expert → cc-opus-high (model opus)
    const text = readFileSync(r!.promptPath, "utf8");
    expect(text).toContain("thoughtful person speaks"); // shared voice
    expect(text).toContain("Joe, how the operative writes"); // joe stance
  });

  it("PlacementResult carries the resolved target attribution (targetId/runtime/provider)", async () => {
    const r = await place("dev-env");
    expect(r).not.toBeNull();
    // balanced computeLadder[expert] → cc-opus-high (runtime claude-code / provider anthropic-plan)
    expect(r!.targetId).toBe("cc-opus-high");
    expect(r!.runtime).toBe("claude-code");
    expect(r!.provider).toBe("anthropic-plan");
  });

  it("appends a placement decision row with the mirrored shape when decisionsPath is set", async () => {
    const decisionsPath = join(mkdtempSync(join(tmpdir(), "decisions-")), ".garrison", "decisions.jsonl");
    const r = await placeOrchestratedSession({
      channel: "dev-env",
      mode: "james",
      modesDir: MODES_DIR,
      routingConfigPath: RCONF,
      outDir: mkdtempSync(join(tmpdir(), "place-")),
      decisionsPath
    });
    expect(r).not.toBeNull();
    // the helper creates the parent .garrison dir on demand
    expect(existsSync(decisionsPath)).toBe(true);
    const lines = readFileSync(decisionsPath, "utf8").trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]);
    // field names mirror the orchestrator fitting's decisionRecord + the placement extras
    expect(rec).toMatchObject({
      taskType: "dev-env-session",
      tier: null, // placement is mode-based, never tier-classified
      ruleId: null, // no routing rule matched — the mode bias picked the role
      role: r!.role,
      targetId: r!.targetId,
      profile: "balanced",
      via: "placement",
      runtime: r!.runtime,
      provider: r!.provider,
      model: r!.model,
      channel: "dev-env",
      mode: "james"
    });
    expect(typeof rec.at).toBe("string");
    expect(Date.parse(rec.at)).not.toBeNaN();
    expect(rec.promptDigest).toBeNull();
  });

  it("writes NO decision row when placement falls back bare (no modes fitting)", async () => {
    const empty = mkdtempSync(join(tmpdir(), "nomodes-"));
    const decisionsPath = join(mkdtempSync(join(tmpdir(), "decisions-bare-")), ".garrison", "decisions.jsonl");
    const r = await placeOrchestratedSession({
      channel: "dev-env",
      modesDir: empty, // no modes.json → placement returns null before the telemetry point
      routingConfigPath: RCONF,
      outDir: empty,
      decisionsPath
    });
    expect(r).toBeNull();
    expect(existsSync(decisionsPath)).toBe(false); // bare fallback stays silent — no row
  });

  it("slack and web channels place Gary", async () => {
    expect((await place("slack"))!.mode).toBe("gary");
    expect((await place("web"))!.mode).toBe("gary");
  });

  it("an explicit mode overrides the channel default", async () => {
    const r = await place("dev-env", "james");
    expect(r!.mode).toBe("james");
    expect(readFileSync(r!.promptPath, "utf8")).toContain("James, the face that feels most");
  });

  it("rejects a path-separator mode id (config traversal defense) — returns null, writes nothing (s3a cross-model gate)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evilmodes-"));
    // a malformed modes.json whose mode key would escape outDir as `${mode}.md`
    writeFileSync(
      join(dir, "modes.json"),
      JSON.stringify({ sharedVoiceRef: "v.md", defaultMode: "../../evil", modes: { "../../evil": { soulRef: "s.md" } } }),
      "utf8"
    );
    const r = await placeOrchestratedSession({
      channel: "main", // no channel default → falls to the bad defaultMode
      modesDir: dir,
      routingConfigPath: RCONF,
      outDir: mkdtempSync(join(tmpdir(), "place-evil-"))
    });
    expect(r).toBeNull(); // guarded before any soul read / prompt write
  });

  it("safeComposition rejects a traversal-y composition id back to 'default' (s3c r2)", () => {
    expect(safeComposition("default")).toBe("default");
    expect(safeComposition("my-comp_2")).toBe("my-comp_2");
    expect(safeComposition("../../etc")).toBe("default");
    expect(safeComposition("a/b")).toBe("default");
    expect(safeComposition("..")).toBe("default");
    expect(safeComposition(null)).toBe("default");
    expect(safeComposition(42)).toBe("default");
  });

  it("resolvePlacementPaths prefers the composition's LIVE config, falling back to seed (s3c r2)", () => {
    // The installed state this probes (apm_modules/_local/modes, .garrison/routing.json) is
    // local + gitignored, so it MUST NOT be asserted against the real compositions dir — its
    // content varies by machine. Drive both branches with a controlled fixture root instead.
    const compositionsDir = mkdtempSync(join(tmpdir(), "comps-"));
    const rootDir = ROOT; // real repo root → the seed fallbacks resolve to the actual seed dirs

    // a composition with BOTH pieces installed → resolves to the LIVE paths
    const liveModes = join(compositionsDir, "live", "apm_modules", "_local", "modes");
    const liveGarrison = join(compositionsDir, "live", ".garrison");
    mkdirSync(liveModes, { recursive: true });
    mkdirSync(liveGarrison, { recursive: true });
    writeFileSync(join(liveModes, "modes.json"), "{}", "utf8");
    writeFileSync(join(liveGarrison, "routing.json"), "{}", "utf8");
    const live = resolvePlacementPaths("live", { compositionsDir, rootDir });
    expect(live.modesDir).toBe(liveModes);
    expect(live.routingConfigPath).toBe(join(liveGarrison, "routing.json"));

    // a composition with NEITHER installed → both fall back to the seed defaults
    const ghost = resolvePlacementPaths("nonexistent-comp", { compositionsDir, rootDir });
    expect(ghost.modesDir).toContain(join("fittings", "seed", "modes"));
    expect(ghost.routingConfigPath).toContain("routing.seed.json");

    // a traversal id is sanitized to "default" before any path join (same result as "default")
    const def = resolvePlacementPaths("default", { compositionsDir, rootDir });
    expect(resolvePlacementPaths("../../etc", { compositionsDir, rootDir })).toEqual(def);
  });

  it("the active composition flows end-to-end into placement (runner -> dev-env env -> caller -> route) (s3c r3)", () => {
    // source-invariant on the three wiring points the live boot relies on (the spawn
    // path is heavy to instantiate; the resolution semantics are unit-tested above):
    const runnerSrc = readFileSync(join(ROOT, "src/lib/runner.ts"), "utf8");
    const serverSrc = readFileSync(join(ROOT, "fittings/seed/dev-env/scripts/server.mjs"), "utf8");
    const routeSrc = readFileSync(join(ROOT, "src/app/api/orchestrator/place/route.ts"), "utf8");
    // 1) runner-managed boot projects the active composition id into the own-port env
    expect(runnerSrc).toContain("GARRISON_COMPOSITION_ID: compositionId");
    // 2) the dev-env caller forwards it to the placement route when set
    expect(serverSrc).toContain("GARRISON_COMPOSITION_ID");
    expect(serverSrc).toMatch(/composition\s*\?\s*\{\s*composition\s*\}/);
    // 3) the route sanitizes + honors it (no always-default)
    expect(routeSrc).toContain("safeComposition(body.composition)");
  });

  it("returns null when the modes fitting is absent", async () => {
    const empty = mkdtempSync(join(tmpdir(), "nomodes-"));
    const r = await placeOrchestratedSession({
      channel: "dev-env",
      modesDir: empty,
      routingConfigPath: RCONF,
      outDir: empty
    });
    expect(r).toBeNull();
  });
});

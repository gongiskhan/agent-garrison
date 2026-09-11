import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";

const fixture = vi.hoisted(() => ({
  root: "",
  getComposition: vi.fn(),
  putComposition: vi.fn()
}));

vi.mock("@/lib/paths", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/paths")>(),
  get ROOT_DIR() { return fixture.root; },
  get COMPOSITIONS_DIR() { return path.join(fixture.root, "compositions"); }
}));
vi.mock("@/lib/state-client", () => ({
  stateClient: () => fixture,
  StateUnavailableError: class extends Error {}
}));
vi.mock("@/lib/library", () => ({
  readLibrary: async () => [{
    id: "fixture-monitor", name: "Fixture monitor", faculty: "observability",
    repo: "local:fixture-monitor", localPath: "fittings/seed/fixture-monitor",
    summary: "Fixture", platforms: ["claude-code"], ratings: {},
    metadata: {
      faculty: "observability", cardinality_hint: "multi", component_shape: "script",
      platforms: ["claude-code"], config_schema: [], provides: [], consumes: [],
      default_fit: true, verify: { command: "echo ok", expect: "ok", timeout_ms: 1000 }
    }
  }]
}));

let writeComposition: typeof import("@/lib/compositions").writeComposition;
let manifestPath: string;
const manifest = `# Authored description must survive a repair.
name: fixture
version: 0.1.0
target: claude
x-garrison:
  composition:
    id: fixture
    name: Fixture
    # Keep the configuration rationale beside its value.
    global_config:
      greeting: neutral
    selections:
      observability:
        - id: fixture-monitor
          config: {}
    schema: 4
    # User-authored duty documentation stays here.
    duties: []
    selected_duties: []
    targets: []
`;

beforeAll(async () => {
  fixture.root = await mkdtemp(path.join(os.tmpdir(), "garrison-composition-writer-"));
  manifestPath = path.join(fixture.root, "compositions", "fixture", "apm.yml");
  await mkdir(path.dirname(manifestPath), { recursive: true });
  ({ writeComposition } = await import("@/lib/compositions"));
});

beforeEach(async () => {
  vi.stubEnv("GARRISON_STATE_URL", "http://authority.invalid");
  vi.stubEnv("GARRISON_STATE_TOKEN", "synthetic-test-token");
  vi.stubEnv("GARRISON_NODE_NAME", "fixture-node");
  fixture.getComposition.mockReset().mockResolvedValue({ rev: 17 });
  fixture.putComposition.mockReset().mockResolvedValue({ rev: 18 });
  await writeFile(manifestPath, manifest);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(fixture.root, { recursive: true, force: true });
});

describe("composition writer uses the shared manifest persistence path", () => {
  it("preserves prose and the opt-out while publishing exactly the saved bytes with rev CAS", async () => {
    const result = await writeComposition("fixture", { selections: { observability: [] } });
    const saved = await readFile(manifestPath, "utf8");
    expect(saved).toContain("# Authored description must survive a repair.");
    expect(saved).toContain("# Keep the configuration rationale beside its value.");
    expect(saved).toContain("# User-authored duty documentation stays here.");
    expect(parse(saved)["x-garrison"].composition.unfitted).toEqual(["fixture-monitor"]);
    expect(result.selections.observability ?? []).toEqual([]);
    expect(fixture.putComposition).toHaveBeenCalledTimes(1);
    expect(fixture.putComposition).toHaveBeenCalledWith("fixture", saved, { ifMatchRev: 17 });
    expect(parse(saved)["x-garrison"].composition.global_config.archive).toEqual({
      extract_target: "cc-sonnet", max_file_mb: 25, pdf_max_pages: 30, author: "Gonçalo"
    });
  });

  it("uses the existing create CAS when the authority has no composition yet", async () => {
    fixture.getComposition.mockResolvedValue(null);
    await writeComposition("fixture", { name: "Renamed fixture" });
    expect(fixture.putComposition).toHaveBeenCalledTimes(1);
    expect(fixture.putComposition).toHaveBeenCalledWith(
      "fixture", await readFile(manifestPath, "utf8"), { ifMatchRev: 0 }
    );
  });

  it("reports authority failure instead of returning a successful local-only edit", async () => {
    fixture.getComposition.mockRejectedValue(new Error("state api 503"));
    await expect(writeComposition("fixture", { name: "Renamed fixture" })).rejects.toThrow(
      /saved locally but NOT to the mesh state service.*state api 503/
    );
    expect(fixture.putComposition).not.toHaveBeenCalled();
    expect(await readFile(manifestPath, "utf8")).toContain("Renamed fixture");
  });

  it("surfaces an intervening authority revision conflict without retrying or overwriting it", async () => {
    fixture.putComposition.mockRejectedValue(new Error("state api 409: revision conflict"));
    await expect(writeComposition("fixture", { name: "Renamed fixture" })).rejects.toThrow(/409: revision conflict/);
    expect(fixture.getComposition).toHaveBeenCalledTimes(1);
    expect(fixture.putComposition).toHaveBeenCalledTimes(1);
    expect(fixture.putComposition.mock.calls[0][2]).toEqual({ ifMatchRev: 17 });
  });
});

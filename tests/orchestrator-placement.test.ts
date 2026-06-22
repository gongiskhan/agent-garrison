import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { placeOrchestratedSession, resolvePlacementMode } from "../src/lib/orchestrator-placement";

const ROOT = join(__dirname, "..");
const MODES_DIR = join(ROOT, "fittings/seed/modes");
const RCONF = join(ROOT, "fittings/seed/model-router/config/routing.seed.json");
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

  it("slack and web channels place Gary", async () => {
    expect((await place("slack"))!.mode).toBe("gary");
    expect((await place("web"))!.mode).toBe("gary");
  });

  it("an explicit mode overrides the channel default", async () => {
    const r = await place("dev-env", "james");
    expect(r!.mode).toBe("james");
    expect(readFileSync(r!.promptPath, "utf8")).toContain("James, the face that feels most");
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

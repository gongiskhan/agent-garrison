import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STEP_TYPES, validateAutomation, normalizeAutomation } from "../fittings/seed/automations/lib/types.mjs";
import { saveAutomation, getAutomation, listAutomations, deleteAutomation, writeStepEvidence, saveMatrixRun, getMatrixRun } from "../fittings/seed/automations/lib/store.mjs";

// E1 — the Automations engine scaffold: YAML store + the 8 step types + a
// validator. Sandbox GARRISON_AUTOMATIONS_DIR so tests never touch the real
// ~/.garrison/automations.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "garrison-autos-"));
  process.env.GARRISON_AUTOMATIONS_DIR = dir;
});

afterEach(() => {
  delete process.env.GARRISON_AUTOMATIONS_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("automation schema (E1)", () => {
  it("declares exactly the 8 step types (no ekoa_action)", () => {
    expect(STEP_TYPES).toEqual([
      "browser",
      "verify",
      "navigate",
      "wait",
      "local_command",
      "api_call",
      "connector",
      "sub_automation"
    ]);
    expect(STEP_TYPES).not.toContain("ekoa_action");
  });

  it("validates a well-formed automation and rejects an unknown step type", () => {
    const ok = normalizeAutomation({ id: "a1", name: "A", steps: [{ type: "navigate", url: "https://x" }] });
    expect(validateAutomation(ok)).toBe(true);
    expect(() => validateAutomation({ id: "a", name: "A", steps: [{ type: "ekoa_action" }] })).toThrow(/unknown type/);
  });

  it("requires id + name + array steps", () => {
    expect(() => validateAutomation({ name: "A", steps: [] })).toThrow(/id/);
    expect(() => validateAutomation({ id: "a", steps: [] })).toThrow(/name/);
    expect(() => validateAutomation({ id: "a", name: "A", steps: {} })).toThrow(/steps/);
  });

  it("rejects duplicate step ids (the action cache is keyed by step id)", () => {
    expect(() =>
      validateAutomation({ id: "a", name: "A", steps: [{ id: "s1", type: "wait" }, { id: "s1", type: "wait" }] })
    ).toThrow(/duplicate step id/);
  });
});

describe("YAML automation store (E1)", () => {
  it("round-trips an automation through YAML (save -> get)", async () => {
    const saved = await saveAutomation({
      id: "export-doc",
      name: "Export latest doc & email it",
      trigger: { type: "manual" },
      inputs: [{ name: "recipient_email", required: true }],
      steps: [
        { type: "navigate", url: "https://docs.google.com" },
        { type: "connector", connector: "google", action: "gmail.send" },
        { type: "verify", expectedOutcome: "the email shows as sent" }
      ]
    });
    expect(saved.id).toBe("export-doc");
    const loaded = await getAutomation("export-doc");
    expect(loaded.name).toBe("Export latest doc & email it");
    expect(loaded.steps).toHaveLength(3);
    expect(loaded.steps[1]).toMatchObject({ type: "connector", connector: "google", action: "gmail.send" });
  });

  it("lists and deletes automations", async () => {
    await saveAutomation({ id: "one", name: "One", steps: [] });
    await saveAutomation({ id: "two", name: "Two", steps: [] });
    const list = await listAutomations();
    expect(list.map((a) => a.id).sort()).toEqual(["one", "two"]);
    expect(await deleteAutomation("one")).toBe(true);
    expect(await getAutomation("one")).toBeNull();
  });

  it("auto-generates an id when none is given, and writes a .yml file", async () => {
    const saved = await saveAutomation({ name: "Auto", steps: [] });
    expect(saved.id).toBeTruthy();
    expect(existsSync(path.join(dir, `${saved.id}.yml`))).toBe(true);
  });

  it("rejects a path-traversal id", async () => {
    await expect(getAutomation("../escape")).rejects.toThrow(/invalid automation id/);
  });

  it("step enable flags: normalizeAutomation defaults enabled=true and tags=[] per step", async () => {
    const auto = normalizeAutomation({
      id: "a",
      name: "A",
      steps: [{ type: "wait" }, { type: "wait", enabled: false, tags: ["smoke"] }]
    });
    expect(auto.steps[0]).toMatchObject({ enabled: true, tags: [] });
    expect(auto.steps[1]).toMatchObject({ enabled: false, tags: ["smoke"] });
  });
});

describe("step evidence + run matrix (E7/E6, atomic writes)", () => {
  it("writeStepEvidence writes a plain JPEG file under runs/<id>/evidence and rejects a traversal run id", async () => {
    const b64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
    const file = await writeStepEvidence("run1", 2, b64);
    expect(file).toMatch(/runs[/\\]run1[/\\]evidence[/\\]step-002\.jpg$/);
    expect(existsSync(file)).toBe(true);
    await expect(writeStepEvidence("../escape", 0, b64)).rejects.toThrow(/invalid run id/);
  });

  it("saveMatrixRun/getMatrixRun round-trip and reject a traversal matrix id atomically (temp+rename, no partial file)", async () => {
    const record = { matrixId: "mx1", automationId: "a", viewports: [{ id: "d" }], results: [{ viewportId: "d", status: "completed" }] };
    await saveMatrixRun(record);
    const loaded = await getMatrixRun("mx1");
    expect(loaded).toMatchObject({ matrixId: "mx1" });
    expect(await getMatrixRun("missing")).toBeNull();
    await expect(saveMatrixRun({ matrixId: "../escape", results: [] })).rejects.toThrow(/invalid matrix id/);
    // no leftover .tmp files after a successful write
    const { readdirSync } = await import("node:fs");
    const runsFiles = readdirSync(path.join(dir, "runs"));
    expect(runsFiles.some((f) => f.endsWith(".tmp"))).toBe(false);
  });
});

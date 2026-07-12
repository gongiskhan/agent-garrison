import { mkdtempSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getActiveComposition,
  setActiveComposition,
  resolveCompositionPointer,
  activeCompositionConfigPath
} from "@/lib/active-composition";
import { appendRunEvidence, readRunEvidence, sha256Hex } from "@/lib/run-evidence";
import {
  switchComposition,
  resolveTargetComposition,
  type SwitchDeps,
  type TargetResolution
} from "@/lib/composition-switch";
import { COMPOSITIONS_DIR } from "@/lib/paths";
// The CLI is an .mjs; its pure arg parser is exported for exactly this test.
import { parseGarrisonUpArgs } from "../scripts/garrison-up.mjs";

let sandbox: string;
const priorHome = process.env.GARRISON_HOME;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "garrison-switch-"));
  process.env.GARRISON_HOME = sandbox;
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.GARRISON_HOME;
  else process.env.GARRISON_HOME = priorHome;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("active-composition pointer", () => {
  it("defaults to the default composition when no config file exists", async () => {
    expect(await getActiveComposition()).toBe("default");
  });

  it("round-trips a written pointer via an atomic write", async () => {
    await setActiveComposition("router-v4");
    expect(await getActiveComposition()).toBe("router-v4");
    // The on-disk file is valid JSON with the pointer.
    const raw = await fs.readFile(activeCompositionConfigPath(), "utf8");
    expect(JSON.parse(raw)).toMatchObject({ active_composition: "router-v4" });
  });

  it("preserves unrelated keys already in the config file", async () => {
    await fs.mkdir(sandbox, { recursive: true });
    await fs.writeFile(
      activeCompositionConfigPath(),
      JSON.stringify({ active_composition: "default", some_other_key: 42 }),
      "utf8"
    );
    await setActiveComposition("e2e-solo");
    const parsed = JSON.parse(await fs.readFile(activeCompositionConfigPath(), "utf8"));
    expect(parsed.active_composition).toBe("e2e-solo");
    expect(parsed.some_other_key).toBe(42);
  });

  it("rejects an empty pointer", async () => {
    await expect(setActiveComposition("   ")).rejects.toThrow(/cannot be empty/);
  });

  it("falls back to default for a blank/corrupt config", async () => {
    await fs.mkdir(sandbox, { recursive: true });
    await fs.writeFile(activeCompositionConfigPath(), "not json at all", "utf8");
    expect(await getActiveComposition()).toBe("default");
  });
});

describe("resolveCompositionPointer", () => {
  it("resolves a plain id under compositions/", () => {
    const r = resolveCompositionPointer("router-v4");
    expect(r.id).toBe("router-v4");
    expect(r.external).toBe(false);
    expect(r.dir).toBe(path.join(COMPOSITIONS_DIR, "router-v4"));
    expect(r.manifestPath).toBe(path.join(COMPOSITIONS_DIR, "router-v4", "apm.yml"));
  });

  it("folds a path INSIDE compositions/ back to its id", () => {
    const r = resolveCompositionPointer(path.join(COMPOSITIONS_DIR, "e2e-solo", "apm.yml"));
    expect(r.id).toBe("e2e-solo");
    expect(r.external).toBe(false);
  });

  it("treats an external apm.yml path as external", () => {
    const r = resolveCompositionPointer("/tmp/somewhere/custom/apm.yml");
    expect(r.external).toBe(true);
    expect(r.id).toBe("custom");
    expect(r.manifestPath).toBe("/tmp/somewhere/custom/apm.yml");
    expect(r.dir).toBe("/tmp/somewhere/custom");
  });

  it("defaults a blank pointer to the default id", () => {
    expect(resolveCompositionPointer("").id).toBe("default");
  });
});

describe("switchComposition — resolve-first discipline", () => {
  function tracker() {
    const order: string[] = [];
    const deps: SwitchDeps = {
      resolveTarget: async (): Promise<TargetResolution> => ({
        resolved: { id: "target", dir: "/x/target", manifestPath: "/x/target/apm.yml", external: false },
        issues: []
      }),
      getActive: async () => "current",
      setActive: async (p) => {
        order.push(`setActive:${p}`);
      },
      up: async (id) => {
        order.push(`up:${id}`);
      },
      down: async (id) => {
        order.push(`down:${id}`);
      }
    };
    return { order, deps };
  }

  it("blocks on a bad target WITHOUT calling down/up or setActive", async () => {
    const { order, deps } = tracker();
    const badResolve: SwitchDeps["resolveTarget"] = async () => ({
      resolved: { id: "bad", dir: "/x/bad", manifestPath: "/x/bad/apm.yml", external: false },
      issues: [
        {
          fittingId: "http-gateway",
          code: "missing-required",
          kind: "orchestrator",
          message: "requires an orchestrator provider but none is stationed"
        }
      ]
    });
    const result = await switchComposition("bad", { ...deps, resolveTarget: badResolve });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("orchestrator");
    expect(result.error).toContain("missing-required");
    // No side effects: nothing was stopped, started, or pointer-flipped.
    expect(order).toEqual([]);
  });

  it("does not flip the real pointer when the resolver blocks", async () => {
    // Real getActive/setActive against the sandbox; injected resolver + up/down.
    await setActiveComposition("default");
    const blocked = await switchComposition("bad", {
      resolveTarget: async () => ({
        resolved: { id: "bad", dir: "/x", manifestPath: "/x/apm.yml", external: false },
        issues: [{ fittingId: "x", code: "missing-required", kind: "orchestrator", message: "nope" }]
      }),
      up: async () => {
        throw new Error("up must not run");
      },
      down: async () => {
        throw new Error("down must not run");
      }
    });
    expect(blocked.ok).toBe(false);
    expect(await getActiveComposition()).toBe("default");
  });

  it("on a clean target: down(current) -> setActive(target) -> up(resolvedId), in order", async () => {
    const { order, deps } = tracker();
    const result = await switchComposition("target", deps);
    expect(result).toEqual({ ok: true, id: "target" });
    expect(order).toEqual(["down:current", "setActive:target", "up:target"]);
  });

  it("returns a readable error and does not flip the pointer if down() fails", async () => {
    const { order, deps } = tracker();
    const result = await switchComposition("target", {
      ...deps,
      down: async () => {
        throw new Error("boom stopping");
      }
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("boom stopping");
    // Pointer was never set, up never ran.
    expect(order).toEqual([]);
  });
});

describe("resolveTargetComposition — real resolver over an on-disk manifest", () => {
  it("resolves the default composition to an issues array", async () => {
    const { resolved, issues } = await resolveTargetComposition("default");
    expect(resolved.id).toBe("default");
    expect(Array.isArray(issues)).toBe(true);
  });

  it("throws a readable error for a missing manifest", async () => {
    const missing = path.join(sandbox, "no-such-composition", "apm.yml");
    await expect(resolveTargetComposition(missing)).rejects.toThrow(/not found or unreadable/);
  });
});

describe("run-evidence", () => {
  async function writeManifest(dir: string, body: string): Promise<string> {
    await fs.mkdir(dir, { recursive: true });
    const p = path.join(dir, "apm.yml");
    await fs.writeFile(p, body, "utf8");
    return p;
  }

  it("records compositionId + a stable sha256 of the apm.yml", async () => {
    const dir = path.join(sandbox, "comp-a");
    const body = "name: comp-a\nversion: 0.1.0\n";
    const manifestPath = await writeManifest(dir, body);
    const rec = await appendRunEvidence({
      compositionDir: dir,
      compositionId: "comp-a",
      manifestPath,
      at: "2026-07-12T00:00:00.000Z"
    });
    expect(rec.compositionId).toBe("comp-a");
    expect(rec.apmYmlSha256).toBe(crypto.createHash("sha256").update(body).digest("hex"));
    expect(rec.apmYmlSha256).toBe(sha256Hex(body));
    expect(rec.at).toBe("2026-07-12T00:00:00.000Z");
  });

  it("appends (does not overwrite) across launches", async () => {
    const dir = path.join(sandbox, "comp-b");
    const manifestPath = await writeManifest(dir, "name: comp-b\n");
    await appendRunEvidence({ compositionDir: dir, compositionId: "comp-b", manifestPath, at: "t1" });
    await appendRunEvidence({ compositionDir: dir, compositionId: "comp-b", manifestPath, at: "t2" });
    const records = await readRunEvidence(dir);
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.at)).toEqual(["t1", "t2"]);
  });

  it("two compositions produce two files with different ids + hashes", async () => {
    const dirA = path.join(sandbox, "two-a");
    const dirB = path.join(sandbox, "two-b");
    const pa = await writeManifest(dirA, "name: two-a\nversion: 1\n");
    const pb = await writeManifest(dirB, "name: two-b\nversion: 2\n");
    const ra = await appendRunEvidence({ compositionDir: dirA, compositionId: "two-a", manifestPath: pa, at: "t" });
    const rb = await appendRunEvidence({ compositionDir: dirB, compositionId: "two-b", manifestPath: pb, at: "t" });
    expect(ra.compositionId).not.toBe(rb.compositionId);
    expect(ra.apmYmlSha256).not.toBe(rb.apmYmlSha256);
    expect((await readRunEvidence(dirA))[0].compositionId).toBe("two-a");
    expect((await readRunEvidence(dirB))[0].compositionId).toBe("two-b");
  });
});

describe("garrison-up CLI arg parsing", () => {
  it("parses --composition <value>", () => {
    expect(parseGarrisonUpArgs(["--composition", "router-v4"])).toEqual({
      composition: "router-v4",
      help: false
    });
  });

  it("parses -c <value>", () => {
    expect(parseGarrisonUpArgs(["-c", "e2e-solo"]).composition).toBe("e2e-solo");
  });

  it("parses --composition=<value>", () => {
    expect(parseGarrisonUpArgs(["--composition=default"]).composition).toBe("default");
  });

  it("returns null composition when the flag is absent", () => {
    expect(parseGarrisonUpArgs([]).composition).toBeNull();
  });

  it("recognises --help", () => {
    expect(parseGarrisonUpArgs(["--help"]).help).toBe(true);
  });
});

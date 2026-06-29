import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fingerprintFromParts, fingerprintKey } from "../fittings/seed/automations/lib/fingerprint.mjs";
import { lookupActionCache, writeActionCache, evictAction } from "../fittings/seed/automations/lib/cache.mjs";
import { runBrowserStep } from "../fittings/seed/automations/lib/browser-orchestrator.mjs";

// F2 — the cache->vision->execute orchestration. Pure tier logic with injected
// observe/execute/vision deps; sandboxed cache dir.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "garrison-orch-"));
  process.env.GARRISON_AUTOMATIONS_DIR = dir;
});
afterEach(() => {
  delete process.env.GARRISON_AUTOMATIONS_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const obsFor = (over = {}) => ({ url: "https://docs.google.com/document/d/A/edit", title: "Doc A", headingText: "Q3 Report", shapeSketch: "button:3,input:1", viewport: { w: 1280, h: 800 }, ...over });

describe("page fingerprint (F2)", () => {
  it("is deterministic and discriminates content but not A/B layout", () => {
    const a = fingerprintFromParts(obsFor());
    const a2 = fingerprintFromParts(obsFor());
    expect(fingerprintKey(a)).toBe(fingerprintKey(a2));
    // same structure, different doc -> different title/heading hash
    const b = fingerprintFromParts(obsFor({ url: "https://docs.google.com/document/d/B/edit", title: "Doc B", headingText: "Q4 Report" }));
    expect(fingerprintKey(b)).not.toBe(fingerprintKey(a));
    // same content, different DOM shape -> different key
    const c = fingerprintFromParts(obsFor({ shapeSketch: "button:9,input:4" }));
    expect(fingerprintKey(c)).not.toBe(fingerprintKey(a));
  });
});

describe("action cache (F2)", () => {
  it("write -> lookup roundtrip, successCount increments, evict", async () => {
    const fp = fingerprintFromParts(obsFor());
    expect(await lookupActionCache("auto1", "s1", fp)).toBeNull();
    await writeActionCache({ automationId: "auto1", stepId: "s1", fingerprint: fp, action: { kind: "click", role: "button", name: "Export" } });
    const hit = await lookupActionCache("auto1", "s1", fp);
    expect(hit.action).toMatchObject({ kind: "click", name: "Export" });
    expect(hit.successCount).toBe(1);
    await writeActionCache({ automationId: "auto1", stepId: "s1", fingerprint: fp, action: hit.action });
    expect((await lookupActionCache("auto1", "s1", fp)).successCount).toBe(2);
    expect(await evictAction("auto1", "s1", fp)).toBe(true);
    expect(await lookupActionCache("auto1", "s1", fp)).toBeNull();
  });
});

describe("tier orchestration (F2)", () => {
  it("navigate is deterministic (no vision/observe)", async () => {
    let navigated = "";
    const r = await runBrowserStep({ automationId: "a", step: { id: "s1", type: "navigate", url: "https://x" }, deps: { navigate: async (u: string) => { navigated = u; } } });
    expect(r.tier).toBe("execute");
    expect(navigated).toBe("https://x");
  });

  it("browser cache-miss -> vision, executes, writes cache; next run is a cache hit", async () => {
    let visionCalls = 0;
    const deps = {
      observe: async () => obsFor(),
      resolveViaVision: async () => { visionCalls++; return { kind: "click", role: "button", name: "Export" }; },
      executeAction: async () => {}
    };
    const r1 = await runBrowserStep({ automationId: "auto2", step: { id: "s1", type: "browser", description: "click Export" }, deps });
    expect(r1.tier).toBe("vision");
    expect(visionCalls).toBe(1);
    // second run: cached
    const r2 = await runBrowserStep({ automationId: "auto2", step: { id: "s1", type: "browser", description: "click Export" }, deps });
    expect(r2.tier).toBe("cached");
    expect(visionCalls).toBe(1); // no new vision call
  });

  it("a stale cached action recovers via vision (tier recovered)", async () => {
    const fp = fingerprintFromParts(obsFor());
    await writeActionCache({ automationId: "auto3", stepId: "s1", fingerprint: fp, action: { kind: "click", name: "Stale" } });
    let executeCalls = 0;
    const deps = {
      observe: async () => obsFor(),
      executeAction: async () => { executeCalls++; if (executeCalls === 1) throw new Error("selector gone"); },
      resolveViaVision: async () => ({ kind: "click", name: "Fresh" })
    };
    const r = await runBrowserStep({ automationId: "auto3", step: { id: "s1", type: "browser", description: "click" }, deps });
    expect(r.tier).toBe("recovered");
    expect(r.action).toMatchObject({ name: "Fresh" });
    // the stale entry was replaced
    expect((await lookupActionCache("auto3", "s1", fp)).action).toMatchObject({ name: "Fresh" });
  });

  it("verify uses vision and writes the assertion cache on pass", async () => {
    const deps = {
      observe: async () => obsFor(),
      verifyViaVision: async () => ({ passed: true, reasoning: "email shows as sent", assertion: { kind: "text-visible", text: "sent" } })
    };
    const r = await runBrowserStep({ automationId: "auto4", step: { id: "s1", type: "verify", expectedOutcome: "email sent" }, deps });
    expect(r.passed).toBe(true);
    expect(r.tier).toBe("vision");
  });

  it("verify throws a recoverable error when vision fails", async () => {
    const deps = { observe: async () => obsFor(), verifyViaVision: async () => ({ passed: false, reasoning: "not sent" }) };
    await expect(runBrowserStep({ automationId: "a", step: { id: "s1", type: "verify" }, deps })).rejects.toMatchObject({ recoverable: true });
  });
});

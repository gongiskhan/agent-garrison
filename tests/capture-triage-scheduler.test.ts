import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error fitting module is executed directly
import { syncTriageJob, triageEnvPrefix, triageJobId } from "../fittings/seed/capture-service/lib/scheduler-jobs.mjs";
import { loadConfig } from "../fittings/seed/capture-service/lib/config.mjs";

describe("Capture triage scheduling", () => {
  it("keeps each owner's job distinct and never serializes credentials", () => {
    const cfg = loadConfig({ GARRISON_HOME: "/sandbox/owner's capture", GARRISON_CAPTURESERVICE_TRIAGE_ENABLED: "true" });
    const env = { GARRISON_NODE_NAME: "dev-madrid", OMI_WEBHOOK_SECRET: "retired", CAPTURE_TOKEN: "private", GARRISON_STATE_TOKEN: "authority" };
    expect(triageJobId(cfg, env)).toBe("capture-triage-dev-madrid");
    expect(triageJobId(cfg, { GARRISON_NODE_NAME: "mac-mini" })).toBe("capture-triage-mac-mini");
    const command = triageEnvPrefix(cfg, env).join(" ");
    expect(command).toContain("owner'\\''s capture");
    expect(command).not.toMatch(/retired|private|authority|TOKEN|SECRET/);
  });
  it("registers the Capture CLI and removes only this node's job when disabled", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "capture-scheduler-"));
    try {
      const cfg = { ...loadConfig({ GARRISON_HOME: home }), gatewayUrl: "http://gateway.test", triageEnabled: true };
      const calls: any[] = [];
      const opts = { env: { GARRISON_NODE_NAME: "mac-mini" }, log: { log() {}, error() {} }, run: (...args: any[]) => { calls.push(args); return { status: 0 }; } };
      expect(syncTriageJob(cfg, opts)).toBe(true);
      expect(calls[0][1].slice(1, 3)).toEqual(["register", "capture-triage-mac-mini"]);
      expect(calls[0][1].join(" ")).toContain("capture-service/scripts/triage.mjs");
      expect(calls[0][1].join(" ")).not.toContain("omi-channel");
      expect(syncTriageJob({ ...cfg, triageEnabled: false }, opts)).toBe(true);
      expect(calls[1][1].slice(1)).toEqual(["remove", "capture-triage-mac-mini"]);
      expect(syncTriageJob({ ...cfg, gatewayUrl: "" }, opts)).toBe(false);
      expect(calls).toHaveLength(2);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

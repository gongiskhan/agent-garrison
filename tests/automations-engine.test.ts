import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAutomation } from "../fittings/seed/automations/lib/engine.mjs";
import { getRun } from "../fittings/seed/automations/lib/store.mjs";
import { interpolate, interpolateDeep } from "../fittings/seed/automations/lib/template-vars.mjs";

// E2 — the run engine for non-browser steps. Inject deps so no real connector
// subprocess / backend / network is touched.

let dir: string;
let prevHome: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "garrison-engine-"));
  process.env.GARRISON_AUTOMATIONS_DIR = dir;
  // Isolate GARRISON_HOME too, so browser-step discovery (browserBaseUrl reads
  // <home>/ui-fittings/browser-default.json) can't leak the LIVE install's state
  // into the "browser fitting not running" case — which otherwise flakes when a
  // browser fitting is running on the dev machine.
  prevHome = process.env.GARRISON_HOME;
  process.env.GARRISON_HOME = dir;
});
afterEach(() => {
  delete process.env.GARRISON_AUTOMATIONS_DIR;
  if (prevHome === undefined) delete process.env.GARRISON_HOME;
  else process.env.GARRISON_HOME = prevHome;
  rmSync(dir, { recursive: true, force: true });
});

const noSleep = () => Promise.resolve();

describe("template vars", () => {
  it("interpolates input/capture/event with dotted paths", () => {
    const scope = { input: { email: "a@b.com" }, capture: { s1: { id: "card1" } }, event: { path: "/x" } };
    expect(interpolate("to {{input.email}}", scope)).toBe("to a@b.com");
    expect(interpolate("card {{capture.s1.id}}", scope)).toBe("card card1");
    expect(interpolate("at {{event.path}}", scope)).toBe("at /x");
    expect(interpolate("missing {{input.nope}}", scope)).toBe("missing ");
  });
  it("interpolateDeep walks objects + arrays", () => {
    const out = interpolateDeep({ to: "{{input.email}}", tags: ["{{input.email}}"] }, { input: { email: "x@y" } });
    expect(out).toEqual({ to: "x@y", tags: ["x@y"] });
  });
});

describe("run engine (E2)", () => {
  it("runs wait + api_call + connector and persists a completed run", async () => {
    const events: any[] = [];
    const automation = {
      id: "flow1",
      name: "Flow",
      steps: [
        { id: "s1", type: "wait", durationMs: 5 },
        { id: "s2", type: "api_call", apiRequest: { method: "GET", url: "https://api/x" } },
        { id: "s3", type: "connector", connector: "google", action: "gmail.send", args: { to: "{{input.email}}" } }
      ]
    };
    const record = await runAutomation({
      automation,
      inputs: { email: "a@b.com" },
      emit: (e: any) => events.push(e),
      deps: {
        sleep: noSleep,
        fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ files: [] }) }),
        connectorAuthEnv: async () => ({ GOOGLE_ACCESS_TOKEN: "tok" }),
        runConnector: async ({ action, args }: any) => ({ ok: true, result: { sent: true, action, to: args.to } })
      }
    });
    expect(record.status).toBe("completed");
    expect(record.steps.map((s: any) => s.status)).toEqual(["completed", "completed", "completed"]);
    // template var resolved into the connector args
    expect(record.steps[2].result).toMatchObject({ sent: true, to: "a@b.com" });
    expect(events.some((e) => e.type === "run_complete")).toBe(true);
    // persisted
    const loaded = await getRun(record.id);
    expect(loaded.status).toBe("completed");
  });

  it("pauses awaiting_connector when the service is not connected", async () => {
    const events: any[] = [];
    const record = await runAutomation({
      automation: { id: "a", name: "A", steps: [{ id: "s1", type: "connector", connector: "slack", action: "send_message" }] },
      emit: (e: any) => events.push(e),
      deps: { connectorAuthEnv: async () => ({ __awaiting_connector: true }) }
    });
    expect(record.status).toBe("awaiting_connector");
    expect(record.awaitingConnector).toMatchObject({ service: "slack", stepIndex: 0 });
    expect(events.some((e) => e.type === "run_awaiting_connector")).toBe(true);
  });

  it("fails the run and emits run_error when a step throws", async () => {
    const events: any[] = [];
    const record = await runAutomation({
      automation: { id: "a", name: "A", steps: [{ id: "s1", type: "connector", connector: "x", action: "y" }] },
      emit: (e: any) => events.push(e),
      deps: { connectorAuthEnv: async () => ({}), runConnector: async () => ({ ok: false, error: "boom" }) }
    });
    expect(record.status).toBe("failed");
    expect(record.error).toContain("boom");
    expect(events.some((e) => e.type === "run_error")).toBe(true);
  });

  it("streams local_command stdout chunks and captures output", async () => {
    const chunks: string[] = [];
    const record = await runAutomation({
      automation: { id: "a", name: "A", steps: [{ id: "s1", type: "local_command", command: "printf 'hello'" }] },
      emit: (e: any) => { if (e.type === "step_output_chunk") chunks.push(e.chunk); },
      // local_command now requires consent on first use of a shape; approve it.
      deps: { sleep: noSleep, waitForResume: async () => ({ resumed: true, decision: "always" }) }
    });
    expect(record.status).toBe("completed");
    expect(record.steps[0].result.stdout).toContain("hello");
    expect(chunks.join("")).toContain("hello");
  });

  it("runs a sub_automation via the injected runner", async () => {
    const record = await runAutomation({
      automation: { id: "parent", name: "P", steps: [{ id: "s1", type: "sub_automation", sub_automation_id: "child" }] },
      deps: { runSubAutomation: async ({ id }: any) => ({ ran: id }) }
    });
    expect(record.status).toBe("completed");
    expect(record.steps[0].result).toEqual({ ran: "child" });
  });

  it("redacts injected secret/token values from the persisted run record", async () => {
    const record = await runAutomation({
      automation: { id: "a", name: "A", steps: [{ id: "s1", type: "connector", connector: "google", action: "gmail.send" }] },
      deps: {
        connectorAuthEnv: async () => ({ GOOGLE_ACCESS_TOKEN: "ya29.SUPERSECRET" }),
        // a buggy connector that echoes its injected token in the result
        runConnector: async ({ authEnv }: any) => ({ ok: true, result: { echoed: `used ${authEnv.GOOGLE_ACCESS_TOKEN}` } })
      }
    });
    expect(record.status).toBe("completed");
    expect(JSON.stringify(record)).not.toContain("ya29.SUPERSECRET");
    expect(JSON.stringify(record)).toContain("***REDACTED***");
  });

  it("self-heals a recoverable browser step via the fixer (run_patch -> retry succeeds)", async () => {
    const events: any[] = [];
    let attempts = 0;
    const record = await runAutomation({
      automation: { id: "a", name: "A", steps: [{ id: "s1", type: "browser", description: "click Export" }] },
      emit: (e: any) => events.push(e),
      deps: {
        runBrowser: async () => {
          attempts += 1;
          if (attempts === 1) { const e: any = new Error("cookie banner covers the button"); e.recoverable = true; throw e; }
          return { tier: "vision" };
        },
        proposePatch: async () => ({ kind: "insert_before", reasoning: "dismiss banner", newStep: { id: "fix1", type: "browser", description: "Click Reject" } })
      }
    });
    expect(record.status).toBe("completed");
    expect(events.some((e) => e.type === "run_patch" && e.phase === "proposing")).toBe(true);
    expect(events.some((e) => e.type === "run_patch" && e.phase === "applied")).toBe(true);
  });

  it("pauses for the user on a CAPTCHA (fast-path, no fixer call)", async () => {
    let fixerCalled = false;
    const record = await runAutomation({
      automation: { id: "a", name: "A", steps: [{ id: "s1", type: "browser", description: "x" }] },
      deps: {
        runBrowser: async () => { const e: any = new Error("The page shows a Google reCAPTCHA verification page"); e.recoverable = true; throw e; },
        proposePatch: async () => { fixerCalled = true; return { kind: "abort" }; }
      }
    });
    expect(record.status).toBe("paused_for_user");
    expect(record.pause.reasoning).toMatch(/CAPTCHA/i);
    expect(fixerCalled).toBe(false);
  });

  it("fails (no infinite loop) when the fixer cannot recover within budget", async () => {
    let patches = 0;
    const record = await runAutomation({
      automation: { id: "a", name: "A", steps: [{ id: "s1", type: "browser", description: "x" }] },
      deps: {
        runBrowser: async () => { const e: any = new Error("element not found"); e.recoverable = true; throw e; },
        proposePatch: async () => { patches += 1; return { kind: "replace_current", reasoning: "retry", newStep: { id: "s1", type: "browser", description: "retry" } }; }
      }
    });
    expect(record.status).toBe("failed");
    expect(patches).toBeLessThanOrEqual(5); // maxPatchesPerIndex
  });

  it("HITL: a CAPTCHA pauses, then resumes and retries the step to completion", async () => {
    let attempts = 0;
    const record = await runAutomation({
      automation: { id: "a", name: "A", steps: [{ id: "s1", type: "browser", description: "x" }] },
      deps: {
        runBrowser: async () => { attempts += 1; if (attempts === 1) { const e: any = new Error("Google reCAPTCHA verification"); e.recoverable = true; throw e; } return { tier: "vision" }; },
        waitForResume: async () => ({ resumed: true })
      }
    });
    expect(record.status).toBe("completed");
    expect(attempts).toBe(2); // paused, resumed, retried
  });

  it("HITL: an awaiting_connector step resumes after the user connects", async () => {
    let calls = 0;
    const record = await runAutomation({
      automation: { id: "a", name: "A", steps: [{ id: "s1", type: "connector", connector: "google", action: "gmail.send" }] },
      deps: {
        connectorAuthEnv: async () => (++calls === 1 ? { __awaiting_connector: true } : { GOOGLE_ACCESS_TOKEN: "tok" }),
        runConnector: async () => ({ ok: true, result: { sent: true } }),
        waitForResume: async () => ({ resumed: true })
      }
    });
    expect(record.status).toBe("completed");
    expect(record.steps[0].result).toMatchObject({ sent: true });
  });

  it("HITL: a new command shape needs consent; 'always' approves it for next time", async () => {
    let pauses = 0;
    const auto = { id: "a", name: "A", steps: [{ id: "s1", type: "local_command", command: "printf ok" }] };
    const r1 = await runAutomation({ automation: auto, deps: { waitForResume: async () => { pauses += 1; return { resumed: true, decision: "always" }; } } });
    expect(r1.status).toBe("completed");
    expect(pauses).toBe(1);
    // second run: the shape is now approved -> no consent pause
    const r2 = await runAutomation({ automation: auto, deps: { waitForResume: async () => { pauses += 1; return { resumed: true, decision: "always" }; } } });
    expect(r2.status).toBe("completed");
    expect(pauses).toBe(1); // unchanged — no re-prompt
  });

  it("HITL: a pause with no resume capability (headless) returns the paused record", async () => {
    const record = await runAutomation({
      automation: { id: "a", name: "A", steps: [{ id: "s1", type: "local_command", command: "printf ok" }] }
      // no waitForResume
    });
    expect(record.status).toBe("awaiting_consent");
    expect(record.pause).toMatchObject({ kind: "awaiting_consent" });
  });

  it("fails a browser step cleanly when the Browser Fitting is not running", async () => {
    const prev = process.env.GARRISON_BROWSER_URL;
    delete process.env.GARRISON_BROWSER_URL;
    try {
      const record = await runAutomation({
        automation: { id: "a", name: "A", steps: [{ id: "s1", type: "navigate", url: "https://x" }] }
      });
      expect(record.status).toBe("failed");
      expect(record.error).toContain("browser fitting not running");
    } finally {
      if (prev !== undefined) process.env.GARRISON_BROWSER_URL = prev;
    }
  });
});

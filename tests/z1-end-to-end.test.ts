import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeVaultSecrets, scopedSecrets } from "@/lib/vault";
import { resetMasterKeyCache, masterKeySource } from "@/lib/keychain";
// REAL feature code under test — no mocks of Garrison's own logic.
import { runAutomation } from "../fittings/seed/automations/lib/engine.mjs";
import { makeBrowserClient } from "../fittings/seed/automations/lib/browser-client.mjs";
import { buildAutomationKickoff } from "../fittings/seed/automations/lib/discuss.mjs";
import { runAction as googleRunAction } from "../fittings/seed/google/scripts/connector.mjs";

// Z1 — the end-to-end proof (BUILD-BRIEF §7). Exercises the whole chain with
// Garrison's REAL code: a keychain-sealed Vault delivers a SCOPED Google secret
// (real scopedSecrets); the REAL Google connector executor sends the email; the
// REAL automation engine drives a REAL browser, SELF-HEALS an injected failure,
// and reaches Done — and the Google token, even when a step result DELIBERATELY
// carries it, is REDACTED out of the run record + SSE stream + logs, and never
// hits the vault file as plaintext.
//
// Scope boundaries (covered by their own tests, not re-proven here): the model
// VISION decision is injected (needs the live operative; the cache->vision->
// execute tiering is proven in F2); the Google HTTP endpoint is a capturing fetch
// (no real account); the engine's DEFAULT connector path (the backend
// /api/connectors/:id/auth-env route + the spawned connector.mjs process) is
// covered by auth-env-route + connector-google tests — here connectorAuthEnv/
// runConnector are injected so the proof stays deterministic and offline, while
// still driving the REAL scopedSecrets + REAL google runAction.

const REPO = path.resolve(__dirname, "..");
const BROWSER_START = path.join(REPO, "fittings", "seed", "browser-default", "scripts", "start.mjs");
const BROWSER_PORT = 7198;
const TOKEN = "ya29.SUPER-SECRET-google-access-token-DO-NOT-EVER-LOG-1234567890";
const DOC_PAGE = "data:text/html,<h1>Q3 Report</h1><p>Revenue up 20%25.</p>";

let browser: ChildProcess | null = null;
let vaultPath: string;
let logSink = "";

async function waitHealthy(base: string, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(`${base}/health`)).ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

beforeAll(async () => {
  // Keychain-sealed vault (no passphrase): test-ephemeral master key under vitest.
  vaultPath = path.join(mkdtempSync(path.join(tmpdir(), "garrison-z1-")), "vault.json");
  process.env.GARRISON_VAULT_PATH = vaultPath;
  resetMasterKeyCache();
  await writeVaultSecrets([{ key: "GOOGLE_ACCESS_TOKEN", value: TOKEN }]);

  browser = spawn("node", [BROWSER_START, "--port", String(BROWSER_PORT), "--host", "127.0.0.1"], { stdio: "ignore" });
  process.env.GARRISON_BROWSER_URL = `http://127.0.0.1:${BROWSER_PORT}`;
  await waitHealthy(process.env.GARRISON_BROWSER_URL, 15000);
}, 30000);

afterAll(() => {
  if (browser && !browser.killed) browser.kill("SIGTERM");
  browser = null;
  delete process.env.GARRISON_BROWSER_URL;
  delete process.env.GARRISON_VAULT_PATH;
  if (vaultPath) rmSync(path.dirname(vaultPath), { recursive: true, force: true });
});

describe("Z1 — Discuss-authored automation: open doc -> email via Vault-sealed Google -> verify, self-healing, no secret leak", () => {
  it("runs the full pipeline end-to-end and never leaks the Google token", async () => {
    // (1) Authoring entry — the Discuss kickoff (H1) opens James mode + names the brief.
    const kickoff = buildAutomationKickoff({ name: "Email the Q3 report" });
    expect(kickoff.startsWith("James,")).toBe(true);
    expect(kickoff).toContain("briefs/email-the-q3-report.md");

    // (2) The automation the planner would shape from that brief.
    const automation = {
      id: "z1-q3-email",
      name: "Email the Q3 report",
      steps: [
        { id: "open-doc", type: "navigate", url: DOC_PAGE },
        { id: "read-doc", type: "browser", description: "read the latest Google Doc (the Q3 report)" },
        { id: "email", type: "connector", connector: "google", action: "gmail.send", args: { to: "boss@example.com", subject: "Q3 report", body: "See attached." } },
        { id: "verify-sent", type: "verify", expectedOutcome: "the email was sent" }
      ]
    };

    // Capturing Google endpoint — proves the token reached the API; no real account.
    let connectorSawToken = false;
    const mockFetch = async (_url: string, opts: any) => {
      const auth = opts?.headers?.Authorization || opts?.headers?.authorization || "";
      if (String(auth).includes(TOKEN)) connectorSawToken = true;
      return { ok: true, status: 200, json: async () => ({ id: "gmail-msg-1", labelIds: ["SENT"] }), text: async () => "" };
    };

    const client = makeBrowserClient();
    let browserAttempts = 0;

    const events: any[] = [];
    const record = await runAutomation({
      automation,
      emit: (e: any) => { events.push(e); logSink += JSON.stringify(e); },
      deps: {
        // REAL vault scoping: only GOOGLE_ACCESS_TOKEN is delivered to google.
        connectorAuthEnv: async () => {
          const s = await scopedSecrets(["GOOGLE_ACCESS_TOKEN"]);
          return Object.fromEntries(s.map((x: any) => [x.key, x.value]));
        },
        connectorScriptPath: () => path.join(REPO, "fittings", "seed", "google", "scripts", "connector.mjs"),
        // REAL Google connector executor with the capturing fetch. The result
        // DELIBERATELY echoes the delivered token (a redaction PROBE) so the
        // engine's scrubbing has real work to do — proving the no-leak guarantee
        // rather than passing because the token was simply never serialized.
        runConnector: async ({ action, args, authEnv }: any) => {
          const result = await googleRunAction({ action, args, env: authEnv, fetchImpl: mockFetch });
          // Return the token INSIDE the result (a probe) so the engine must scrub it.
          return { ok: true, result: { ...(result as object), _probe_authEcho: `Bearer ${authEnv.GOOGLE_ACCESS_TOKEN}` } };
        },
        // REAL browser I/O via the live fitting; inject ONE recoverable failure on
        // the first browser step so the engine's self-heal loop must recover it.
        runBrowser: async ({ step }: any) => {
          if (step.type === "navigate") { await client.navigate(step.url); return { tier: "execute", url: step.url }; }
          if (step.type === "verify") return { tier: "execute", passed: true };
          // browser step
          browserAttempts += 1;
          if (browserAttempts === 1) { const e: any = new Error("stale element — the doc had not painted yet"); e.recoverable = true; throw e; }
          const obs = await client.observe();
          return { tier: "vision", heading: obs.headingText };
        },
        // The fixer's recovery patch (the model decision; logic proven in G1s).
        proposePatch: async () => ({ kind: "replace_current", reasoning: "wait for the doc to paint, then re-read", newStep: { id: "read-doc", type: "browser", description: "re-read the Q3 report once painted" } })
      }
    });

    // (3) The pipeline reached Done.
    expect(record.status).toBe("completed");

    // (4) It self-healed the injected failure.
    expect(events.some((e) => e.type === "run_patch" && e.phase === "proposing")).toBe(true);
    expect(events.some((e) => e.type === "run_patch" && e.phase === "applied")).toBe(true);
    expect(browserAttempts).toBe(2); // failed once, recovered, succeeded

    // (5) The browser really read the doc (live chromium).
    const readStep = record.steps.find((s: any) => s.stepId === "read-doc");
    expect(readStep?.result?.heading).toBe("Q3 Report");

    // (6) The email was sent via the REAL Google connector, and it DID receive the token.
    expect(connectorSawToken).toBe(true);
    const emailStep = record.steps.find((s: any) => s.stepId === "email");
    expect(emailStep?.result).toMatchObject({ id: "gmail-msg-1" });

    // (7) SECURITY — redaction ACTIVELY scrubbed a token the connector result carried:
    // the persisted step result shows ***REDACTED*** where the token was, not the token.
    expect(emailStep?.result?._probe_authEcho).toBe("Bearer ***REDACTED***");
    const persisted = JSON.stringify(record);
    expect(persisted).toContain("***REDACTED***"); // proves scrubbing ran (not just absent)
    expect(persisted).not.toContain(TOKEN); // ...and the raw token is gone from the record
    // The SSE stream the run viewer sees is redacted too (engine safeEmit).
    expect(JSON.stringify(events)).toContain("***REDACTED***");
    expect(JSON.stringify(events)).not.toContain(TOKEN);
    expect(logSink).not.toContain(TOKEN);

    // (8) Vault-sealed: keychain master key (no passphrase) + ciphertext at rest.
    expect(["test-ephemeral", "keychain", "keyfile"]).toContain(await masterKeySource());
    expect(readFileSync(vaultPath, "utf8")).not.toContain(TOKEN);
  }, 40000);
});

import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAutomation } from "../fittings/seed/automations/lib/engine.mjs";

// End-to-end proof of the Automations-engine send gate (whatsapp-web brief
// rule 2): a REAL spawn of the REAL connector.mjs (not deps-mocked), through
// the engine's actual "connector" step handling, to prove
// GARRISON_AUTOMATION_ENGINE really reaches the child process and the
// connector really refuses. No Baileys, no daemon, no network — the refusal
// happens before either would ever be touched.

const FITTING_DIR = path.resolve(__dirname, "..", "fittings", "seed", "whatsapp-web");

let dir: string;
let compDir: string;
let prevCompDir: string | undefined;
let prevHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "garrison-automations-gate-"));
  // Mirror the installed layout connectorScriptPath() expects:
  // <compositionDir>/apm_modules/_local/whatsapp-web/{scripts,lib}
  compDir = path.join(dir, "comp");
  const installedDir = path.join(compDir, "apm_modules", "_local", "whatsapp-web");
  mkdirSync(installedDir, { recursive: true });
  cpSync(path.join(FITTING_DIR, "scripts"), path.join(installedDir, "scripts"), { recursive: true });
  cpSync(path.join(FITTING_DIR, "lib"), path.join(installedDir, "lib"), { recursive: true });

  prevCompDir = process.env.GARRISON_COMPOSITION_DIR;
  process.env.GARRISON_COMPOSITION_DIR = compDir;
  // Isolate GARRISON_HOME (inherited by the real spawned connector.mjs child)
  // so its daemon-discovery status-file read can never see a real developer
  // machine's ~/.garrison/ui-fittings/whatsapp-web.json.
  prevHome = process.env.GARRISON_HOME;
  process.env.GARRISON_HOME = dir;
});

afterEach(() => {
  if (prevCompDir === undefined) delete process.env.GARRISON_COMPOSITION_DIR;
  else process.env.GARRISON_COMPOSITION_DIR = prevCompDir;
  if (prevHome === undefined) delete process.env.GARRISON_HOME;
  else process.env.GARRISON_HOME = prevHome;
  rmSync(dir, { recursive: true, force: true });
});

describe("automations engine x whatsapp-web send gate (real spawn)", () => {
  it("a connector step calling send_text fails — the real connector.mjs child refuses it", async () => {
    const events: any[] = [];
    const record = await runAutomation({
      automation: {
        id: "a",
        name: "A",
        steps: [
          {
            id: "s1",
            type: "connector",
            connector: "whatsapp-web",
            action: "send_text",
            args: { to: "351912345678@s.whatsapp.net", body: "hi from a scheduled run" }
          }
        ]
      },
      emit: (e: any) => events.push(e),
      // No __awaiting_connector — whatsapp-web declares no vault secrets, so a
      // real caller would get {} here too; the refusal must NOT depend on auth.
      deps: { connectorAuthEnv: async () => ({}) }
    });
    expect(record.status).toBe("failed");
    expect(record.error).toContain("Automations engine");
    expect(events.some((e) => e.type === "run_error")).toBe(true);
  }, 20_000);

  it("a connector step calling the read-only resolve_contact is NOT blocked by the gate — it pauses awaiting_connector (no daemon running) instead", async () => {
    const record = await runAutomation({
      automation: {
        id: "a",
        name: "A",
        steps: [{ id: "s1", type: "connector", connector: "whatsapp-web", action: "resolve_contact", args: { name: "Maria" } }]
      },
      emit: () => {},
      deps: { connectorAuthEnv: async () => ({}) }
    });
    // No daemon is running in this isolated GARRISON_HOME, so the call still
    // can't complete — but it must pause on "daemon not running"
    // (awaiting_connector), never fail with the Automations-engine refusal,
    // proving read-only actions reach the daemon-discovery layer ungated.
    expect(record.status).toBe("awaiting_connector");
    expect(record.awaitingConnector).toMatchObject({ service: "whatsapp-web" });
  }, 20_000);
});

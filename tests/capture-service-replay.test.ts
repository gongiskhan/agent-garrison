// Capture service — the replay client is the E2E driver for later milestones,
// so it is itself under test: run as a real subprocess speaking the full wire
// protocol (from the committed Opus fixtures) against a sandboxed instance,
// including the drop/resume path, the --twice dedupe proof, and the refusal
// modes. If the fixture format or the client's effect-following drifts, this
// fails before M7 ever runs.

import { afterAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "../fittings/seed/capture-service/lib/config.mjs";
import { startServer } from "../fittings/seed/capture-service/scripts/server.mjs";

const execFileAsync = promisify(execFile);
const TOKEN = "replay-test-token";
const CLIENT = path.join(__dirname, "..", "fittings", "seed", "capture-service", "scripts", "replay-client.mjs");

describe("capture-service replay client", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "capture-replay-"));
  let handle: Awaited<ReturnType<typeof startServer>> | null = null;

  afterAll(() => {
    handle?.ingress.close();
    handle?.server.close();
    rmSync(home, { recursive: true, force: true });
  });

  async function boot() {
    if (handle) return handle;
    const cfg = loadConfig({ GARRISON_HOME: home, CAPTURE_TOKEN: TOKEN });
    handle = await startServer({ ...cfg, port: 0, enabled: true });
    return handle;
  }

  it("streams a fixture with a mid-stream drop and --twice, and follows the stored effect", async () => {
    const h = await boot();
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        CLIENT,
        "run",
        "--fixture",
        "pt-command",
        "--mode",
        "screen_audio",
        "--twice",
        "--drop-at",
        "50",
        "--base",
        `http://127.0.0.1:${h.cfg.port}`,
        "--token",
        TOKEN,
        "--session",
        "REPLAYTESTSESSION1"
      ],
      { timeout: 60000 }
    );
    expect(stdout).toContain("session session_started");
    expect(stdout).toContain("server reports high-water audio_seq=49");
    expect(stdout).toContain("every frame deduped");
    expect(stdout).toContain("high-water matches the fixture packet count");
    expect(stdout).toContain("no transcript stored");
  }, 90000);

  it("proves the bad-token and malformed refusal paths", async () => {
    const h = await boot();
    const base = `http://127.0.0.1:${h.cfg.port}`;
    const bad = await execFileAsync(process.execPath, [CLIENT, "bad-token", "--base", base], { timeout: 30000 });
    expect(bad.stdout).toContain("rejected_auth advanced");

    const malformed = await execFileAsync(
      process.execPath,
      [CLIENT, "malformed", "--base", base, "--token", TOKEN],
      { timeout: 30000 }
    );
    expect(malformed.stdout).toContain("no state created");
  }, 90000);
});

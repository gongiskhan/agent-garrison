import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const FITTING = path.resolve(__dirname, "..", "fittings", "seed", "whatsapp-web");
const SETUP = path.join(FITTING, "scripts", "setup.sh");

// setup.sh must never pair the account or touch the network beyond its own
// (already-satisfied) npm install — it only preps the environment. Run it
// against a throwaway $HOME so it never touches the real
// ~/.config/garrison/whatsapp-web.
describe("whatsapp-web setup", () => {
  let home: string;

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("is idempotent, creates the session dir, and never mentions pairing/sending", () => {
    home = mkdtempSync(path.join(os.tmpdir(), "wweb-home-"));
    const env = { ...process.env, HOME: home };

    const first = spawnSync("bash", [SETUP], { env, encoding: "utf8", timeout: 60_000 });
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("whatsapp-web setup ok");
    expect(first.stdout).toContain("not paired yet");
    // setup must describe how to pair, but never attempt it itself.
    expect(first.stdout.toLowerCase()).not.toMatch(/pairing code: \w/);

    const second = spawnSync("bash", [SETUP], { env, encoding: "utf8", timeout: 60_000 });
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("whatsapp-web setup ok");

    expect(existsSync(path.join(home, ".config", "garrison", "whatsapp-web"))).toBe(true);
  });
});

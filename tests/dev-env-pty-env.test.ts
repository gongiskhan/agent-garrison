// The dev-env server receives this fitting's secret_scope (apm.yml) in its
// process env for the voice bridge; a shell or Claude Code tab spawned from it
// must not inherit those values. PTY_ENV_DENY is the strip list and this test
// keeps it in lockstep with the manifest, so adding a secret to the scope
// without deciding what the PTYs see fails here.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "js-yaml";

const PTYS = path.join(__dirname, "..", "fittings", "seed", "dev-env", "scripts", "ptys.mjs");
const MANIFEST = path.join(__dirname, "..", "fittings", "seed", "dev-env", "apm.yml");

describe("dev-env PTY env", () => {
  it("strips every secret_scope key from the PTY env and keeps the terminal settings", async () => {
    const { PTY_ENV_DENY, ptySpawnEnv } = await import(PTYS);
    const manifest = yaml.load(readFileSync(MANIFEST, "utf8")) as { "x-garrison": { secret_scope?: string[] } };
    const scope: string[] = manifest["x-garrison"].secret_scope ?? [];
    expect(scope.length).toBeGreaterThan(0);
    for (const key of scope) expect(PTY_ENV_DENY).toContain(key);

    const env = ptySpawnEnv({ PATH: "/usr/bin", HOME: "/home/x", CAPTURE_TOKEN: "cap-secret", GARRISON_VOICE_FITTING_ID: "capture-service", LANG: "C" });
    expect(env.CAPTURE_TOKEN).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain("cap-secret");
    expect(env.TERM).toBe("xterm-256color");
    expect(env.PATH).toBe("/usr/bin");
    // Non-secret projections stay: the shell may legitimately ask which
    // provider the node runs.
    expect(env.GARRISON_VOICE_FITTING_ID).toBe("capture-service");
    // A non-UTF-8 locale is upgraded so Claude's glyphs render.
    expect(env.LANG).toMatch(/UTF-8/i);
  });
});

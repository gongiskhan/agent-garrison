import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");

describe("retired multi-soul gateway", () => {
  it("always enters the routed PTY gateway, even with a stale souls env var", () => {
    const entry = readFileSync(
      path.join(ROOT, "fittings/seed/http-gateway/scripts/gateway.mjs"),
      "utf8"
    );
    expect(entry).toContain('import("./gateway-pty.mjs")');
    expect(entry).not.toMatch(/process\.env\.GARRISON_SOULS_CONFIG/);
    expect(entry).not.toMatch(/spawn-soul|mode-resolver/);
  });

  it("the runner cannot project a souls configuration", () => {
    const runner = readFileSync(path.join(ROOT, "src/lib/runner.ts"), "utf8");
    expect(runner).not.toMatch(/GARRISON_SOULS_CONFIG|assembleSouls|findModesEntry/);
  });
});

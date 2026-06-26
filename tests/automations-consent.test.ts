import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeCommandShape, shapeForStep, isShapeApproved, approveShape } from "../fittings/seed/automations/lib/command-shape.mjs";

// G2s — command-shape consent.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "garrison-consent-"));
  process.env.GARRISON_AUTOMATIONS_DIR = dir;
});
afterEach(() => {
  delete process.env.GARRISON_AUTOMATIONS_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("command shape (G2s)", () => {
  it("normalizes values to placeholders so the SHAPE is stable across args", () => {
    expect(computeCommandShape(["git", "-C", "~/reports", "status", "--short"])).toBe("git -C <DIR> status --short");
    expect(computeCommandShape(["cat", "/etc/passwd.bak"])).toBe("cat <FILE>");
    expect(computeCommandShape(["cat", "/etc/hosts"])).toBe("cat <DIR>"); // no extension -> dir-shaped
    expect(computeCommandShape(["curl", "https://x.com/y"])).toBe("curl <URL>");
  });
  it("shell-string shapes are per-script (a hash) so one approval can't unlock all scripts", () => {
    const a = computeCommandShape(["bash", "-c", "git status"]);
    const b = computeCommandShape(["bash", "-c", "rm -rf /"]);
    expect(a).toMatch(/^bash -c <SCRIPT:[0-9a-f]{12}>$/);
    expect(a).not.toBe(b); // different scripts -> different shapes
    expect(computeCommandShape(["bash", "-c", "git status"])).toBe(a); // deterministic
  });
  it("shapeForStep handles command-string and argv steps", () => {
    expect(shapeForStep({ command: "git status" })).toMatch(/^bash -c <SCRIPT:[0-9a-f]{12}>$/);
    expect(shapeForStep({ argv: ["ls", "dir/"] })).toBe("ls <DIR>");
  });
  it("approve/isApproved roundtrip", async () => {
    expect(await isShapeApproved("git status")).toBe(false);
    await approveShape("git status");
    expect(await isShapeApproved("git status")).toBe(true);
  });
});

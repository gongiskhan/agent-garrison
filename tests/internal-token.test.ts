import { mkdtempSync, rmSync, writeFileSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getInternalToken, verifyInternalToken, resetInternalTokenCache } from "@/lib/internal-token";

// Guards the internal capability token used by the connector auth-env route.

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "garrison-itok-"));
  file = path.join(dir, "internal-token");
  process.env.GARRISON_INTERNAL_TOKEN_PATH = file;
  resetInternalTokenCache();
});

afterEach(() => {
  delete process.env.GARRISON_INTERNAL_TOKEN_PATH;
  resetInternalTokenCache();
  rmSync(dir, { recursive: true, force: true });
});

describe("internal token", () => {
  it("creates a 0600 token and verifies it (timing-safe)", async () => {
    const token = await getInternalToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await verifyInternalToken(token)).toBe(true);
    expect(await verifyInternalToken("wrong")).toBe(false);
    expect(await verifyInternalToken("")).toBe(false);
    expect(await verifyInternalToken(null)).toBe(false);
  });

  it("repairs a loosened (world-readable) token file mode to 0600", async () => {
    writeFileSync(file, "a".repeat(64), { mode: 0o644 });
    chmodSync(file, 0o644);
    const token = await getInternalToken();
    expect(token).toBe("a".repeat(64));
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

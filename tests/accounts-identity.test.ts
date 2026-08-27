// An account should be recognisable by WHO it is, not just by the name someone
// typed when they added it. The credential a Codex account is built from already
// carries an email claim; reading it costs nothing and needs no network.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string;
const ORIGINAL = process.env.GARRISON_HOME;

function writeCodexAuth(accountName: string, claims: Record<string, unknown>): void {
  const dir = join(home, "runtime-homes", "accounts", `openai-${accountName}`);
  mkdirSync(dir, { recursive: true });
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { id_token: `header.${payload}.signature` } }));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "acct-identity-"));
  process.env.GARRISON_HOME = home;
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.GARRISON_HOME;
  else process.env.GARRISON_HOME = ORIGINAL;
  rmSync(home, { recursive: true, force: true });
});

describe("account identity from a stored credential", () => {
  it("reads the email a Codex credential already carries", async () => {
    const { identityFromCredential } = await import("../src/lib/accounts");
    writeCodexAuth("pro", { email: "goncalo@ekoa.io", name: "Goncalo Gomes" });
    expect(await identityFromCredential("pro", "openai")).toBe("goncalo@ekoa.io");
  });

  it("falls back through the claim names a provider might use", async () => {
    const { identityFromCredential } = await import("../src/lib/accounts");
    writeCodexAuth("byname", { name: "Goncalo Gomes" });
    expect(await identityFromCredential("byname", "openai")).toBe("Goncalo Gomes");
  });

  it("says nothing rather than guessing", async () => {
    const { identityFromCredential } = await import("../src/lib/accounts");
    // Anthropic subscription accounts are an opaque setup token with no home and
    // no free identity endpoint: an honest name beats an invented email.
    expect(await identityFromCredential("max20-ekoa", "anthropic")).toBeNull();
    // A missing, unreadable or reshaped credential must never break the roster.
    expect(await identityFromCredential("absent", "openai")).toBeNull();
    writeCodexAuth("broken", {});
    expect(await identityFromCredential("broken", "openai")).toBeNull();
    const dir = join(home, "runtime-homes", "accounts", "openai-garbage");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "auth.json"), "not json at all");
    expect(await identityFromCredential("garbage", "openai")).toBeNull();
  });

  it("never verifies the token - it is a display label, not an authorization", async () => {
    const { identityFromCredential } = await import("../src/lib/accounts");
    // A signature this code cannot check is still fine to READ from: the account
    // is already trusted enough to run with.
    writeCodexAuth("unsigned", { email: "someone@example.com" });
    expect(await identityFromCredential("unsigned", "openai")).toBe("someone@example.com");
  });
});

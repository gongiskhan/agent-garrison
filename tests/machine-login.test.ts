import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planLabel, readMachineLogin, readMachineLogins } from "@/lib/machine-login";

// RUNTIME-ACCOUNTS-V1 UX — the machine-login identity reader. Sandboxed Claude
// config dir via GARRISON_CLAUDE_HOME + GARRISON_CLAUDE_JSON so nothing touches
// the real ~/.claude. The reader must surface identity + status WITHOUT ever
// exposing a token value.

const ACCESS_TOKEN = "sk-ant-oat01-machine-login-secret-should-never-leak";

let home: string;
let claudeJson: string;

function writeConfig(oauthAccount: Record<string, unknown> | null): void {
  writeFileSync(claudeJson, JSON.stringify(oauthAccount ? { oauthAccount } : {}), "utf8");
}

function writeCredentials(oauth: Record<string, unknown> | null): void {
  const credsPath = path.join(home, ".credentials.json");
  writeFileSync(credsPath, JSON.stringify(oauth ? { claudeAiOauth: oauth } : {}), "utf8");
}

beforeEach(() => {
  const root = mkdtempSync(path.join(tmpdir(), "garrison-machine-login-"));
  home = path.join(root, ".claude");
  claudeJson = path.join(root, ".claude.json");
  mkdirSync(home, { recursive: true });
  process.env.GARRISON_CLAUDE_HOME = home;
  process.env.GARRISON_CLAUDE_JSON = claudeJson;
});

afterEach(() => {
  delete process.env.GARRISON_CLAUDE_HOME;
  delete process.env.GARRISON_CLAUDE_JSON;
  delete process.env.GARRISON_CODEX_HOME;
  delete process.env.GARRISON_GEMINI_HOME;
  rmSync(path.dirname(home), { recursive: true, force: true });
});

describe("planLabel", () => {
  it("prefers a claude_max rate-limit tier and formats the multiplier", () => {
    expect(planLabel("max", "default_claude_max_20x")).toBe("Max 20×");
    expect(planLabel("max", "claude_max_5x")).toBe("Max 5×");
  });

  it("falls back through generic tiers then subscriptionType", () => {
    expect(planLabel("pro", "pro_tier")).toBe("Pro");
    expect(planLabel("max", null)).toBe("Max");
    expect(planLabel("team", null)).toBe("Team");
    expect(planLabel(null, null)).toBeNull();
  });
});

describe("readMachineLogin", () => {
  it("reports a fresh box as not logged in", async () => {
    const machine = await readMachineLogin();
    expect(machine.loggedIn).toBe(false);
    expect(machine.source).toBe("none");
    expect(machine.email).toBeNull();
    expect(machine.platform).toBe("anthropic");
    expect(machine.configPath).toBe(home);
  });

  it("surfaces identity + plan for a logged-in box and never leaks the token", async () => {
    writeConfig({
      emailAddress: "person@example.com",
      displayName: "Person",
      organizationName: "Person's Org",
      organizationRateLimitTier: "default_claude_max_20x"
    });
    writeCredentials({
      accessToken: ACCESS_TOKEN,
      refreshToken: "sk-ant-ort01-refresh-secret",
      subscriptionType: "max",
      expiresAt: Date.now() + 3_600_000
    });

    const machine = await readMachineLogin();
    expect(machine.loggedIn).toBe(true);
    expect(machine.source).toBe("credentials");
    expect(machine.email).toBe("person@example.com");
    expect(machine.displayName).toBe("Person");
    expect(machine.plan).toBe("Max 20×");
    expect(machine.expired).toBe(false);

    // Token discipline: no field of the payload may carry the secret.
    expect(JSON.stringify(machine)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(machine)).not.toContain("refresh-secret");
  });

  it("marks a cached profile with no credential as signed out (profile-only)", async () => {
    writeConfig({ emailAddress: "stale@example.com", displayName: "Stale" });
    // no .credentials.json
    const machine = await readMachineLogin();
    expect(machine.loggedIn).toBe(false);
    expect(machine.source).toBe("profile-only");
    expect(machine.email).toBe("stale@example.com");
  });

  it("flags an expired credential (still logged in; it refreshes on use)", async () => {
    writeConfig({ emailAddress: "person@example.com" });
    writeCredentials({
      accessToken: ACCESS_TOKEN,
      subscriptionType: "pro",
      expiresAt: Date.now() - 1_000
    });
    const machine = await readMachineLogin();
    expect(machine.loggedIn).toBe(true);
    expect(machine.expired).toBe(true);
    expect(machine.plan).toBe("Pro");
  });
});

describe("readMachineLogins (all platforms)", () => {
  it("detects Codex (auth.json) and Gemini (oauth_creds.json) native logins", async () => {
    const root = path.dirname(home);
    const codexHome = path.join(root, ".codex");
    const geminiHome = path.join(root, ".gemini");
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(geminiHome, { recursive: true });
    process.env.GARRISON_CODEX_HOME = codexHome;
    process.env.GARRISON_GEMINI_HOME = geminiHome;
    writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "sk-openai-secret", tokens: { access_token: "tok" } }),
      "utf8"
    );
    // Gemini creds absent → not logged in.

    const logins = await readMachineLogins();
    const byPlatform = Object.fromEntries(logins.map((l) => [l.platform, l]));
    expect(byPlatform.anthropic.platform).toBe("anthropic");
    expect(byPlatform.openai.loggedIn).toBe(true);
    expect(byPlatform.openai.source).toBe("credentials");
    expect(byPlatform.google.loggedIn).toBe(false);
    // Token discipline: never leak the codex key.
    expect(JSON.stringify(logins)).not.toContain("sk-openai-secret");
  });
});

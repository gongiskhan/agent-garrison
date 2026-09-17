import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAccount } from "@/lib/accounts";
import { readVaultSecrets, unlockVault } from "@/lib/vault";
import { resetMasterKeyCache } from "@/lib/keychain";

const authority = vi.hoisted(() => ({ enrolled: true, putSecret: vi.fn() }));
vi.mock("@/lib/state-client", () => ({
  stateEnrolled: () => authority.enrolled,
  withState: (fn: (client: { putSecret: typeof authority.putSecret }) => unknown) => fn(authority)
}));
const OLD = "sk-ant-oat01-old-fixture-token-0123456789";
const NEW = "sk-ant-oat01-new-fixture-token-0123456789";
const KEY = "ANTHROPIC_ACCOUNT__work";
let dir: string;
function reset() {
  globalThis.__agentGarrisonVault = undefined;
  resetMasterKeyCache();
}
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "garrison-login-authority-"));
  vi.stubEnv("GARRISON_HOME", dir);
  vi.stubEnv("GARRISON_VAULT_PATH", path.join(dir, "vault.json"));
  reset();
  authority.enrolled = true;
  authority.putSecret.mockReset().mockResolvedValue({ ok: true });
  await unlockVault();
});
afterEach(() => { reset(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

describe("account login authority", () => {
  it("replaces the shared credential before updating the local vault", async () => {
    await addAccount({ name: "work", token: OLD });
    authority.putSecret.mockImplementationOnce(async (key, token) => {
      expect(key).toBe(KEY);
      expect(token).toBe(NEW);
      expect((await readVaultSecrets()).find(s => s.key === KEY)?.value).toBe(OLD);
    });
    await addAccount({ name: "work", token: NEW });
    expect(authority.putSecret).toHaveBeenLastCalledWith(KEY, NEW);
    expect((await readVaultSecrets()).find(s => s.key === KEY)?.value).toBe(NEW);
  });

  it("preserves the local credential and registry if the authority refuses the replacement", async () => {
    await addAccount({ name: "work", token: OLD });
    const registry = readFileSync(path.join(dir, "accounts.json"), "utf8");
    authority.putSecret.mockRejectedValueOnce(new Error("authority unavailable"));
    await expect(addAccount({ name: "work", token: NEW })).rejects.toThrow("authority unavailable");
    expect((await readVaultSecrets()).find(s => s.key === KEY)?.value).toBe(OLD);
    expect(readFileSync(path.join(dir, "accounts.json"), "utf8")).toBe(registry);
  });

  it("keeps standalone logins local", async () => {
    authority.enrolled = false;
    await addAccount({ name: "work", token: NEW });
    expect(authority.putSecret).not.toHaveBeenCalled();
    expect((await readVaultSecrets()).find(s => s.key === KEY)?.value).toBe(NEW);
  });
});

import { describe, expect, it } from "vitest";
import {
  compatibleRuntimeAccounts,
  runtimeAccountContract,
  runtimeAccountSelectionIssue,
  type AccountInfo,
  type AccountPlatform,
  type CredentialKind
} from "@/components/accounts/shared";

function account(
  name: string,
  credentialKind: CredentialKind,
  platform: AccountPlatform = "openai"
): AccountInfo {
  return {
    name,
    created_at: "2026-08-03T00:00:00.000Z",
    status: "ready",
    ageDays: 0,
    enabled: true,
    ceiling: 90,
    platform,
    credential_kind: credentialKind
  };
}

describe("provider-aware runtime account contracts", () => {
  it("keeps OpenAI Agents on the API-token rail while Codex permits subscription login", () => {
    expect(runtimeAccountContract("openai-agents-runtime", undefined, "openai")).toEqual({
      platform: "openai",
      allowAuthFile: false,
      emptyMode: "default-key"
    });
    expect(runtimeAccountContract("openai-agents-runtime", undefined, "openai-compat")).toEqual({
      platform: "openai",
      allowAuthFile: false,
      emptyMode: "default-key"
    });
    expect(runtimeAccountContract("codex-runtime")).toEqual({
      platform: "openai",
      allowAuthFile: true,
      emptyMode: "machine-login"
    });
  });

  it("maps GLM to its token-only default-key contract and keyless providers to null", () => {
    expect(runtimeAccountContract("openai-agents-runtime", undefined, "glm")).toEqual({
      platform: "glm",
      allowAuthFile: false,
      emptyMode: "default-key"
    });
    expect(runtimeAccountContract("openai-agents-runtime", undefined, "ollama-local")).toBeNull();
    expect(runtimeAccountContract("openai-agents-runtime", undefined, "unknown-provider")).toBeNull();
  });

  it("filters auth-file accounts out of OpenAI Agents without removing them from Codex", () => {
    const accounts = [
      account("openai-key", "token"),
      account("chatgpt-subscription", "auth-file"),
      account("glm-key", "token", "glm")
    ];
    const agents = runtimeAccountContract("openai-agents-runtime", undefined, "openai")!;
    const codex = runtimeAccountContract("codex-runtime")!;

    expect(compatibleRuntimeAccounts(accounts, agents).map((item) => item.name)).toEqual([
      "openai-key"
    ]);
    expect(compatibleRuntimeAccounts(accounts, codex).map((item) => item.name)).toEqual([
      "openai-key",
      "chatgpt-subscription"
    ]);
  });

  it("classifies persisted incompatible values so the UI can show and clear them", () => {
    const accounts = [
      account("chatgpt-subscription", "auth-file"),
      account("glm-key", "token", "glm")
    ];
    const agents = runtimeAccountContract("openai-agents-runtime", undefined, "openai")!;

    expect(runtimeAccountSelectionIssue("chatgpt-subscription", agents, accounts)?.kind).toBe(
      "auth-file-not-supported"
    );
    expect(runtimeAccountSelectionIssue("glm-key", agents, accounts)?.kind).toBe("wrong-platform");
    expect(runtimeAccountSelectionIssue("auto", agents, accounts)?.kind).toBe("auto-not-supported");
    expect(runtimeAccountSelectionIssue("removed", agents, accounts)?.kind).toBe("missing-account");
    expect(runtimeAccountSelectionIssue("stale", null, accounts)?.kind).toBe(
      "provider-has-no-account-contract"
    );
    expect(runtimeAccountSelectionIssue("", null, accounts)).toBeNull();
  });
});

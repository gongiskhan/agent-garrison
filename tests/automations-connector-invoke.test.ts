// D26 (docs/decisions/2026-09-garrison-app.md): the automations engine resolves
// legacy connector ids ONCE, at the top of the invoke path, so no automation
// authored against the retired deepgram-voice connector has to be rewritten and
// no manifest has to provide the old name. `voice` is hosted by capture-service,
// so its connector.mjs lives under that fitting's directory.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONNECTOR_ID_ALIASES,
  canonicalConnectorId,
  connectorScriptPath,
  defaultConnectorAuthEnv
} from "../fittings/seed/automations/lib/connector-invoke.mjs";

describe("canonicalConnectorId", () => {
  it("maps the retired deepgram id to voice and leaves every other id alone", () => {
    expect(CONNECTOR_ID_ALIASES).toEqual({ deepgram: "voice" });
    expect(canonicalConnectorId("deepgram")).toBe("voice");
    expect(canonicalConnectorId("voice")).toBe("voice");
    expect(canonicalConnectorId("google")).toBe("google");
    expect(canonicalConnectorId("trello")).toBe("trello");
  });
});

describe("connectorScriptPath", () => {
  const saved = process.env.GARRISON_COMPOSITION_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.GARRISON_COMPOSITION_DIR;
    else process.env.GARRISON_COMPOSITION_DIR = saved;
  });

  it("points voice (and the deepgram alias) at capture-service's connector.mjs", () => {
    process.env.GARRISON_COMPOSITION_DIR = "/comp";
    expect(connectorScriptPath("voice")).toBe("/comp/apm_modules/_local/capture-service/scripts/connector.mjs");
    expect(connectorScriptPath("deepgram")).toBe("/comp/apm_modules/_local/capture-service/scripts/connector.mjs");
    expect(connectorScriptPath("slack")).toBe("/comp/apm_modules/_local/slack-channel/scripts/connector.mjs");
    expect(connectorScriptPath("google")).toBe("/comp/apm_modules/_local/google/scripts/connector.mjs");
    expect(connectorScriptPath("trello")).toBe("/comp/apm_modules/_local/trello/scripts/connector.mjs");
  });
});

describe("defaultConnectorAuthEnv", () => {
  const savedBase = process.env.GARRISON_BASE_URL;
  afterEach(() => {
    if (savedBase === undefined) delete process.env.GARRISON_BASE_URL;
    else process.env.GARRISON_BASE_URL = savedBase;
  });

  it("asks auth-env for the CANONICAL id (no fitting provides the alias)", async () => {
    process.env.GARRISON_BASE_URL = "http://garrison.test";
    const fetchImpl = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ env: { DEEPGRAM_API_KEY: "k" }, url })
    }));
    const env = await defaultConnectorAuthEnv("deepgram", fetchImpl);
    expect(env).toEqual({ DEEPGRAM_API_KEY: "k" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe("http://garrison.test/api/connectors/voice/auth-env");
  });
});

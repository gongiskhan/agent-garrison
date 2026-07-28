import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyInternalToken: vi.fn(async () => true),
  readLibrary: vi.fn(async () => []),
  findRoutingConfigPath: vi.fn(() => "/tmp/routing.json"),
  readRoutingConfig: vi.fn(async () => ({})),
  resolveRoute: vi.fn(() => ({ target: { id: "legacy-image-route" } }))
}));

vi.mock("@/lib/internal-token", () => ({
  verifyInternalToken: mocks.verifyInternalToken
}));
vi.mock("@/lib/library", () => ({
  readLibrary: mocks.readLibrary
}));
vi.mock("@/lib/model-router", () => ({
  findRoutingConfigPath: mocks.findRoutingConfigPath,
  readRoutingConfig: mocks.readRoutingConfig,
  resolveRoute: mocks.resolveRoute
}));

import { POST } from "../src/app/api/automations/vision/route";
import { parseVisionModelReply } from "../src/app/api/automations/vision/input";

function request(body: Record<string, unknown>) {
  return new Request("http://127.0.0.1/api/automations/vision", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-garrison-internal": "test-token"
    },
    body: JSON.stringify(body)
  });
}

describe("automation Vision route", () => {
  let home: string;
  const previousHome = process.env.GARRISON_HOME;
  const previousGateway = process.env.GARRISON_GATEWAY_URL;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "garrison-vision-route-"));
    process.env.GARRISON_HOME = home;
    process.env.GARRISON_GATEWAY_URL = "http://gateway.test";
    vi.clearAllMocks();
    mocks.verifyInternalToken.mockResolvedValue(true);
    mocks.readLibrary.mockResolvedValue([]);
    mocks.findRoutingConfigPath.mockReturnValue("/tmp/routing.json");
    mocks.readRoutingConfig.mockResolvedValue({});
    mocks.resolveRoute.mockReturnValue({ target: { id: "legacy-image-route" } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (previousHome === undefined) delete process.env.GARRISON_HOME;
    else process.env.GARRISON_HOME = previousHome;
    if (previousGateway === undefined) delete process.env.GARRISON_GATEWAY_URL;
    else process.env.GARRISON_GATEWAY_URL = previousGateway;
    rmSync(home, { recursive: true, force: true });
  });

  it("routes as internal work, exposes the screenshot during the turn, and removes it afterward", async () => {
    let gatewayBody: any;
    let screenshotPath = "";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      gatewayBody = JSON.parse(String(init?.body));
      const pathMatch = gatewayBody.message.match(
        /A current screenshot is available at ("(?:[^"\\]|\\.)*")\./
      );
      expect(pathMatch).not.toBeNull();
      screenshotPath = JSON.parse(pathMatch[1]);
      expect(existsSync(screenshotPath)).toBe(true);
      expect(statSync(screenshotPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(screenshotPath).subarray(0, 3)).toEqual(
        Buffer.from([0xff, 0xd8, 0xff])
      );
      return new Response(
        JSON.stringify({
          reply: '{"passed":true,"reasoning":"grounded"}',
          route: "cc-sonnet-med",
          session_id: "aaaa1111-bbbb-4ccc-8ddd-eeee22223333",
          transcript_path: "/home/user/.claude/projects/x/aaaa1111-bbbb-4ccc-8ddd-eeee22223333.jsonl"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const screenshotB64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
    const response = await POST(
      request({
        observation: {
          url: "http://app.test",
          title: "App",
          a11y: [],
          screenshotB64
        },
        step: { description: "the page is usable" },
        mode: "verify",
        contextTag: "drill"
      })
    );

    expect(response.status).toBe(200);
    // Session linkage (S31): the gateway's session id + transcript path ride
    // through so the automations engine can stamp them on the step record.
    expect(await response.json()).toEqual({
      result: { passed: true, reasoning: "grounded" },
      routedVia: "cc-sonnet-med",
      sessionId: "aaaa1111-bbbb-4ccc-8ddd-eeee22223333",
      transcriptPath: "/home/user/.claude/projects/x/aaaa1111-bbbb-4ccc-8ddd-eeee22223333.jsonl"
    });
    expect(gatewayBody.channel).toBe("garrison");
    expect(gatewayBody.classification).toEqual({
      taskType: "image",
      tier: "T1-standard",
      contextKind: "automation-vision:drill",
      matchedException: "ex-automation-vision"
    });
    expect(gatewayBody.message).toContain("MUST use the Read tool");
    expect(existsSync(screenshotPath)).toBe(false);
  });

  it("uses the stronger exception for a blind adversarial pass", async () => {
    let gatewayBody: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        gatewayBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            reply: '{"passed":false,"reasoning":"independent review"}',
            route: "cc-opus-high"
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      })
    );

    const response = await POST(
      request({
        observation: { url: "http://app.test", title: "App", a11y: [] },
        step: { description: "independently assess the page" },
        mode: "judge",
        contextTag: "drill-adversarial"
      })
    );

    expect(response.status).toBe(200);
    expect(gatewayBody.classification.matchedException).toBe(
      "ex-automation-vision-adversarial"
    );
    expect(gatewayBody.classification.tier).toBe("T2-deep");
    expect((await response.json()).routedVia).toBe("cc-opus-high");
  });

  it("rejects malformed screenshot bytes before contacting the gateway", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      request({
        observation: {
          url: "http://app.test",
          screenshotB64: Buffer.from("not an image").toString("base64")
        },
        step: { description: "inspect the page" },
        mode: "verify"
      })
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("not a supported");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Vision model reply parser", () => {
  it("accepts a literal newline inside a JSON string and preserves nested objects", () => {
    expect(
      parseVisionModelReply(
        'preface { "passed": true, "reasoning": "first line\nsecond line", "assertion": { "kind": "visible" } } [route: x]'
      )
    ).toEqual({
      passed: true,
      reasoning: "first line\nsecond line",
      assertion: { kind: "visible" }
    });
  });

  it("repairs terminal-stripped escapes around quotes inside prose", () => {
    expect(
      parseVisionModelReply(
        '{ "passed": true, "reasoning": "Verify lang="pt-PT" on the html element.", "assertion": { "kind": "attribute-equals", "selector": "html", "attribute": "lang", "value": "pt-PT" } }'
      )
    ).toEqual({
      passed: true,
      reasoning: 'Verify lang="pt-PT" on the html element.',
      assertion: {
        kind: "attribute-equals",
        selector: "html",
        attribute: "lang",
        value: "pt-PT"
      }
    });
  });

  it("does not guess at structurally malformed JSON", () => {
    expect(() =>
      parseVisionModelReply('{ "passed": true, "reasoning": missing-quotes }')
    ).toThrow(/invalid JSON/);
  });
});

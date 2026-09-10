import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ token: vi.fn(async () => "internal-test-token"), tailnet: vi.fn(async () => "https://one.tail123.ts.net:8497") }));
vi.mock("node:fs/promises", () => ({ readFile: vi.fn(async () => JSON.stringify({ url: "http://127.0.0.1:8097" })) }));
vi.mock("@/lib/claude-home", () => ({ garrisonDir: () => "/tmp/unused-capture-test" }));
vi.mock("@/lib/capture-credential", () => ({ ensureCaptureCredential: mocks.token }));
vi.mock("@/lib/voice-provider", () => ({ voiceProviderId: async () => "capture-service" }));
vi.mock("@/lib/node-identity", () => ({ readNodeIdentity: () => ({ id: "one" }) }));
vi.mock("@/lib/tailnet-serve", () => ({ tailnetUrlForPort: mocks.tailnet }));
vi.mock("@/lib/state-client", () => ({ stateEnrolled: () => false }));
import { GET } from "@/app/api/capture/bootstrap/route";
const origin = "https://one.tail123.ts.net/api/capture/bootstrap";
beforeEach(() => { vi.clearAllMocks(); mocks.tailnet.mockResolvedValue("https://one.tail123.ts.net:8497"); });
describe("native capture bootstrap", () => {
  it("refuses browser and cross-origin requests without returning or reading a credential", async () => {
    for (const headers of [{}, { "x-garrison-native": "capture-bootstrap", origin: "https://evil.example" }, { "x-garrison-native": "capture-bootstrap", "sec-fetch-site": "same-origin" }]) {
      const response = await GET(new Request(origin, { headers }));
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain("internal-test-token");
    }
    expect(mocks.token).not.toHaveBeenCalled();
  });
  it("returns the mapped HTTPS endpoint with no-cache headers to a native caller", async () => {
    const response = await GET(new Request(origin, { headers: { "x-garrison-native": "capture-bootstrap" } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ name: "one", shellOrigin: "https://one.tail123.ts.net", captureBaseURL: "https://one.tail123.ts.net:8497", token: "internal-test-token", nodes: [] });
  });
  it("refuses a mismatched capture host before returning credentials", async () => {
    mocks.tailnet.mockResolvedValue("https://different.tail123.ts.net:8497");
    const response = await GET(new Request(origin, { headers: { "x-garrison-native": "capture-bootstrap" } }));
    expect(response.status).toBe(400);
    expect(mocks.token).not.toHaveBeenCalled();
  });
});

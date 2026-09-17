import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ accounts: vi.fn(), token: vi.fn() }));
vi.mock("@/lib/connector-auth", () => ({ listConnectorAccounts: mocks.accounts, getConnectorAccountToken: mocks.token }));
import { GET } from "../src/app/api/messages/providers/google/labels/route";
const scope = "https://www.googleapis.com/auth/gmail.modify";
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("Messages existing Gmail label catalog", () => {
  it("materializes only the selected account token and returns label metadata", async () => {
    mocks.accounts.mockResolvedValue([{ id: "a", scopes: [scope] }, { id: "b", scopes: [scope] }]);
    mocks.token.mockResolvedValue("fixture-token");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ labels: [{ id: "Label_1", name: "Clients", type: "user" }] })));
    vi.stubGlobal("fetch", fetchImpl);
    const result = await GET(new NextRequest("http://labels.fixture/api/messages/providers/google/labels?account=b"));
    expect(mocks.token).toHaveBeenCalledWith("google", "b");
    expect(await result.json()).toEqual({ account: "b", labels: [{ id: "Label_1", name: "Clients", type: "user" }] });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it("refuses unknown or insufficient-scope accounts without materializing credentials", async () => {
    mocks.accounts.mockResolvedValue([{ id: "a", scopes: ["https://www.googleapis.com/auth/gmail.send"] }]);
    for (const account of ["a", "missing"]) {
      const result = await GET(new NextRequest(`http://labels.fixture/api/messages/providers/google/labels?account=${account}`));
      expect(result.status).toBe(503);
      expect((await result.json()).error).toContain("reconnect Google");
    }
    expect(mocks.token).not.toHaveBeenCalled();
  });
});

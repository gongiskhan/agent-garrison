import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ list: vi.fn(), store: vi.fn() }));
vi.mock("@/lib/connector-auth", () => ({ listConnectorAccounts: mocks.list, setConnectorOAuthAccount: mocks.store }));
import { GET, POST } from "../src/app/api/connectors/[id]/messages-accounts/route";
import { SLACK_MESSAGES_SCOPES } from "../packages/messages/providers/slack-common";

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe("Messages connector account setup", () => {
  it("returns account metadata without credential identifiers", async () => {
    mocks.list.mockResolvedValue([{ id: "TONE", label: "One", grantId: "slack:TONE", scopes: ["chat:write"] }]);
    const response = await GET(new Request("http://localhost/api/connectors/slack/messages-accounts"), { params: { id: "slack" } });
    expect(await response.json()).toEqual({ accounts: [{ id: "TONE", label: "One", scopes: ["chat:write"] }] });
  });
  it("rejects a bot token before making a provider request", async () => {
    const fetchImpl = vi.fn(); vi.stubGlobal("fetch", fetchImpl);
    const response = await POST(new Request("http://localhost/api/connectors/slack/messages-accounts", { method: "POST", body: JSON.stringify({ token: "xoxb-fixture" }) }), { params: { id: "slack" } });
    expect(response.status).toBe(400); expect(fetchImpl).not.toHaveBeenCalled(); expect(mocks.store).not.toHaveBeenCalled();
  });
  it("stores the verified workspace identity and exact granted scopes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, team_id: "TONE", team: "One", user_id: "UOWNER" }), { headers: { "x-oauth-scopes": SLACK_MESSAGES_SCOPES.join(",") } })));
    const response = await POST(new Request("http://localhost/api/connectors/slack/messages-accounts", { method: "POST", body: JSON.stringify({ token: "xoxp-fixture" }) }), { params: { id: "slack" } });
    expect(await response.json()).toEqual({ account: { id: "TONE", label: "One", address: "UOWNER" }, missingScopes: [] });
    expect(mocks.store).toHaveBeenCalledWith("slack", { id: "TONE", label: "One", address: "UOWNER" }, { accessToken: "xoxp-fixture", scopes: SLACK_MESSAGES_SCOPES, status: "valid" });
  });
  it("reports missing scopes rather than claiming the token can read messages", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, team_id: "TONE", user_id: "UOWNER" }), { headers: { "x-oauth-scopes": "chat:write" } })));
    const response = await POST(new Request("http://localhost/api/connectors/slack/messages-accounts", { method: "POST", body: JSON.stringify({ token: "xoxp-fixture" }) }), { params: { id: "slack" } });
    expect((await response.json()).missingScopes).toContain("im:history");
  });
});

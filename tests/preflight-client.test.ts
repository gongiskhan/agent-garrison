import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });

async function client(state: unknown, status = 200) {
  vi.resetModules();
  vi.stubEnv("GARRISON_APP_URL", "http://preflight-fixture.invalid");
  const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ state }), { status })).mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ fittingId: "fixture", ok: true }] })));
  vi.stubGlobal("fetch", fetchImpl);
  // @ts-ignore
  const api = await import("../fittings/seed/preflight/lib/app-client.mjs");
  return { api, fetchImpl };
}

describe("Preflight CLI sweep lifecycle guard", () => {
  it.each(["running", "starting", "stopping", "installing", "verifying", "unknown"])("refuses %s without calling verify", async (status) => {
    const { api, fetchImpl } = await client({ status });
    expect(await api.runVerifySweep("fixture")).toMatchObject({ ok: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("refuses unavailable state instead of treating it as stopped", async () => {
    const { api, fetchImpl } = await client(null, 503);
    expect(await api.runVerifySweep("fixture")).toMatchObject({ ok: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each(["idle", "failed"])("allows %s and uses only the supplied app", async (status) => {
    const { api, fetchImpl } = await client({ status });
    expect(await api.runVerifySweep("fixture")).toMatchObject({ ok: true, results: [{ fittingId: "fixture", ok: true }] });
    expect(fetchImpl.mock.calls[1]).toEqual(["http://preflight-fixture.invalid/api/runner/fixture/verify", expect.objectContaining({ method: "POST" })]);
  });
});

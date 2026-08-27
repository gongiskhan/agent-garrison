// visionResolve transport retry (2026-08-07): the gateway answers turns one at
// a time, so one long conversation turn can hold the lane past undici's 300s
// header deadline - the engine's vision fetch then dies with "fetch failed"
// seconds before the lane frees, and that single transport blip opened the
// run circuit and skipped 322 checks. A transport failure now retries in
// place (3s, then 15s) and only a persistent failure escalates to the
// circuit-opening vision-transport error.
import { describe, expect, it } from "vitest";
// @ts-ignore -- pure .mjs engine module
import { visionResolve } from "../fittings/seed/automations/lib/engine.mjs";

process.env.GARRISON_BASE_URL = "http://fixture.invalid";

const okResponse = () => ({
  ok: true,
  status: 200,
  json: async () => ({ result: { passed: true }, routedVia: "cc-sonnet-med" })
});

describe("visionResolve transport retry", () => {
  it("retries a failed fetch in place and succeeds without surfacing an error", async () => {
    let calls = 0;
    const slept: number[] = [];
    const fetchImpl = async () => {
      calls++;
      if (calls < 3) throw new TypeError("fetch failed");
      return okResponse() as any;
    };
    const result = await visionResolve({}, { id: "s1" }, "verify", null, fetchImpl, null, async (ms: number) => { slept.push(ms); });
    expect(result).toEqual({ passed: true });
    expect(calls).toBe(3);
    expect(slept).toEqual([3000, 15000]);
  });

  it("escalates to the circuit-opening vision-transport failure only after every retry fails", async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; throw new TypeError("fetch failed"); };
    await expect(
      visionResolve({}, { id: "s1" }, "verify", null, fetchImpl, null, async () => {})
    ).rejects.toMatchObject({
      failure: { class: "infrastructure", component: "vision", code: "vision-transport" }
    });
    expect(calls).toBe(3);
  });

  it("does not retry an HTTP error response - the status carries its own failure code", async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; return { ok: false, status: 502, json: async () => ({ error: "gateway 500" }) } as any; };
    await expect(
      visionResolve({}, { id: "s1" }, "verify", null, fetchImpl, null, async () => {})
    ).rejects.toMatchObject({ failure: { code: "vision-http-502" } });
    expect(calls).toBe(1);
  });
});

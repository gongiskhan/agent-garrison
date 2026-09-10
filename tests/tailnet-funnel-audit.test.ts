import { it, expect } from "vitest";
// @ts-expect-error Operational audit is an ESM CLI.
import { publicFunnels } from "../scripts/audit-funnels.mjs";
it("distinguishes private Serve from background and foreground public listeners", () => {
  expect(publicFunnels({ Web: { "node:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:1234" } } } }, AllowFunnel: { "node:443": false } })).toEqual([]);
  expect(publicFunnels({ AllowFunnel: { "node:8443": true }, Web: { "node:8443": { Handlers: { "/hook": {} } } }, Foreground: { session: { AllowFunnel: { "node:10000": true } } } })).toEqual([
    { scope: "background", hostPort: "node:8443", paths: ["/hook"] },
    { scope: "background/foreground/session", hostPort: "node:10000", paths: [] }
  ]);
  expect(() => publicFunnels(null)).toThrow();
});

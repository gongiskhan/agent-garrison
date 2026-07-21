import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The Browser Fitting drives a real Chromium and can read page content, so its
// CSRF origin guard is security-critical. It originally required the Origin's
// host to be LOOPBACK, which also rejected the Fitting's own page whenever
// Garrison was reached over the tailnet: a `<script type="module">` is fetched
// with CORS and carries Origin: https://<tailnet-host>:<port>, so the bundle
// 403'd and the SPA never booted — a blank Browser pane, while curl (no Origin
// header) looked healthy.
//
// The rule is now same-origin: Origin must match the Host the request arrived
// on. These tests pin BOTH halves — that legitimate same-origin traffic is
// allowed on any hostname, and that genuine cross-origin attackers are still
// rejected. Loosening a CSRF check without the second half would be a
// regression waiting to happen.

const SERVER = path.join(
  process.cwd(),
  "fittings",
  "seed",
  "browser-default",
  "scripts",
  "server.mjs"
);

// Load the guard out of the server module without booting Chromium.
function loadGuard(): (origin: string | undefined, host: string | undefined) => boolean {
  const source = readFileSync(SERVER, "utf8");
  const start = source.indexOf("function isAllowedOrigin(");
  expect(start, "isAllowedOrigin must exist in the browser server").toBeGreaterThan(-1);
  // Take the function through its closing brace at column 0.
  const end = source.indexOf("\n}", start);
  const fnSource = source.slice(start, end + 2);
  // eslint-disable-next-line no-new-func
  return new Function(`${fnSource}; return isAllowedOrigin;`)() as ReturnType<typeof loadGuard>;
}

describe("browser Fitting CSRF origin guard", () => {
  const isAllowedOrigin = loadGuard();

  it("allows a server-to-server caller that sends no Origin", () => {
    expect(isAllowedOrigin(undefined, "127.0.0.1:8084")).toBe(true);
  });

  it("allows loopback origins (the local canvas)", () => {
    expect(isAllowedOrigin("http://127.0.0.1:8084", "127.0.0.1:8084")).toBe(true);
    expect(isAllowedOrigin("http://localhost:8084", "localhost:8084")).toBe(true);
  });

  it("allows the tailnet origin when it matches the Host — the case that was 403ing", () => {
    // `tailscale serve` preserves the original Host, so a proxied same-origin
    // request compares equal. This is what unblocks the embedded view.
    expect(
      isAllowedOrigin(
        "https://dev-madrid.tail31efa.ts.net:8484",
        "dev-madrid.tail31efa.ts.net:8484"
      )
    ).toBe(true);
  });

  it("still rejects a genuine cross-origin attacker", () => {
    expect(
      isAllowedOrigin("https://evil.example.com", "dev-madrid.tail31efa.ts.net:8484")
    ).toBe(false);
    expect(isAllowedOrigin("https://evil.example.com", "127.0.0.1:8084")).toBe(false);
  });

  it("rejects a same-host origin on a DIFFERENT port (a distinct origin)", () => {
    // Another Fitting on the same tailnet host must not drive the browser.
    expect(
      isAllowedOrigin(
        "https://dev-madrid.tail31efa.ts.net:8489",
        "dev-madrid.tail31efa.ts.net:8484"
      )
    ).toBe(false);
  });

  it("rejects a lookalike hostname that merely contains the real one", () => {
    expect(
      isAllowedOrigin(
        "https://dev-madrid.tail31efa.ts.net.evil.com",
        "dev-madrid.tail31efa.ts.net"
      )
    ).toBe(false);
  });

  it("rejects an unparseable Origin, and any Origin when the Host is missing", () => {
    expect(isAllowedOrigin("not-a-url", "127.0.0.1:8084")).toBe(false);
    expect(isAllowedOrigin("https://dev-madrid.tail31efa.ts.net:8484", undefined)).toBe(false);
  });

  it("keeps both guards on the shared helper so they cannot drift apart", () => {
    const source = readFileSync(SERVER, "utf8");
    // One definition, two call sites (HTTP request + WebSocket upgrade).
    expect(source.match(/function isAllowedOrigin\(/g)?.length).toBe(1);
    expect(source.match(/isAllowedOrigin\(/g)?.length).toBeGreaterThanOrEqual(3);
    // The old loopback-only rule must not survive anywhere in the guards.
    expect(source).not.toMatch(/loopback = h === "127\.0\.0\.1"/);
  });
});

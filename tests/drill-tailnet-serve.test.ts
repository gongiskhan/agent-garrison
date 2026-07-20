import { describe, expect, it } from "vitest";
// @ts-expect-error untyped fitting-local ESM module
import { serveMapFromStatus, rehostToTailnet } from "../fittings/seed/drill/lib/tailnet-serve.mjs";

// Drill hands the browser absolute URLs into the Browser fitting (canvas
// embeds). The user is usually NOT on the Garrison machine - they reach the UI
// over the HTTPS tailnet address, where a loopback URL is unreachable and a
// plain-http rebind is mixed content. These pin the serve-status parse and the
// origin swap that produce the remote-safe canvasTailnetUrl the server pairs
// with every canvasUrl.

const STATUS = {
  Web: {
    "dev-madrid.tail31efa.ts.net:8484": { Handlers: { "/": { Proxy: "http://127.0.0.1:8084" } } },
    "dev-madrid.tail31efa.ts.net:8486": { Handlers: { "/": { Proxy: "http://localhost:8086" } } },
    // handler not at "/" - ignored
    "dev-madrid.tail31efa.ts.net:9999": { Handlers: { "/sub": { Proxy: "http://127.0.0.1:1234" } } },
    // proxy to a non-loopback host - not a local port mapping
    "dev-madrid.tail31efa.ts.net:9998": { Handlers: { "/": { Proxy: "http://10.0.0.5:4444" } } }
  }
};

describe("drill tailnet-serve", () => {
  it("parses `tailscale serve status` into localPort -> https URL", () => {
    const map = serveMapFromStatus(STATUS);
    expect(map.get(8084)).toBe("https://dev-madrid.tail31efa.ts.net:8484");
    expect(map.get(8086)).toBe("https://dev-madrid.tail31efa.ts.net:8486");
    expect(map.has(1234)).toBe(false);
    expect(map.has(4444)).toBe(false);
    expect(serveMapFromStatus({}).size).toBe(0);
    expect(serveMapFromStatus(null).size).toBe(0);
  });

  it("rehosts a mapped loopback URL preserving path and query", () => {
    const map = serveMapFromStatus(STATUS);
    const rehosted = rehostToTailnet(
      "http://127.0.0.1:8084/canvas/tab-1?embed=1&viewportWidth=1280&viewportHeight=800",
      map
    );
    expect(rehosted).toBe(
      "https://dev-madrid.tail31efa.ts.net:8484/canvas/tab-1?embed=1&viewportWidth=1280&viewportHeight=800"
    );
  });

  it("returns null for unmapped ports, garbage, and empty input", () => {
    const map = serveMapFromStatus(STATUS);
    expect(rehostToTailnet("http://127.0.0.1:9090/canvas/tab-1", map)).toBeNull();
    expect(rehostToTailnet("not a url", map)).toBeNull();
    expect(rehostToTailnet(null, map)).toBeNull();
    expect(rehostToTailnet("", map)).toBeNull();
  });
});

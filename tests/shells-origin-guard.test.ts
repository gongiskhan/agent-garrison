// The fitting's CORS/Origin guard: a tailnet/loopback/RFC1918 Origin is
// allowed even cross-origin (node A's page calling node B's fitting), a
// public one is refused, and a rebound Host is refused outright.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-ignore — pure .mjs
import { isTrustedHost, verdict } from "../fittings/seed/remote-shell-runtime/lib/origin-guard.mjs";
// @ts-ignore — pure .mjs
import { startServer } from "../fittings/seed/remote-shell-runtime/scripts/server.mjs";

describe("isTrustedHost / verdict", () => {
  it("classifies loopback, RFC1918, tailnet CGNAT, and *.ts.net as trusted", () => {
    for (const h of ["127.0.0.1", "localhost", "10.1.2.3", "172.20.0.5", "192.168.1.1", "100.90.1.1", "dev-madrid.tail31efa.ts.net"]) {
      expect(isTrustedHost(h)).toBe(true);
    }
  });

  it("refuses a public host or IP", () => {
    for (const h of ["example.com", "8.8.8.8", "evil.tail31efa.ts.net.evil.com"]) {
      expect(isTrustedHost(h)).toBe(false);
    }
  });

  it("allows a trusted-host Origin even when it differs from Host (cross-node)", () => {
    const v = verdict({ host: "dev-madrid.tail31efa.ts.net:8498", origin: "https://mini.tail31efa.ts.net" });
    expect(v.blocked).toBe(false);
  });

  it("refuses a public Origin", () => {
    const v = verdict({ host: "127.0.0.1:8098", origin: "https://example.com" });
    expect(v.blocked).toBe(true);
    expect(v.reason).toContain("Origin");
  });

  it("refuses a rebound Host outright, Origin notwithstanding", () => {
    const v = verdict({ host: "evil.com", origin: "https://dev-madrid.tail31efa.ts.net" });
    expect(v.blocked).toBe(true);
    expect(v.reason).toContain("Host");
  });
});

describe("live server", () => {
  let tmpHome: string;
  let priorHome: string | undefined;
  let priorLocal: string | undefined;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    tmpHome = mkdtempSync(path.join(os.tmpdir(), "rsh-origin-"));
    priorHome = process.env.GARRISON_HOME;
    priorLocal = process.env.GARRISON_REMOTESHELLRUNTIME_LOCAL_SHELLS;
    process.env.GARRISON_HOME = tmpHome;
    process.env.GARRISON_REMOTESHELLRUNTIME_LOCAL_SHELLS = "false";
    mkdirSync(path.join(tmpHome, "remote-shell"), { recursive: true });
    server = await startServer({ port: 0, host: "127.0.0.1", notifyFittings: [], sessionWindowDays: 5, indexPublishSeconds: 3600 });
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (priorHome === undefined) delete process.env.GARRISON_HOME;
    else process.env.GARRISON_HOME = priorHome;
    if (priorLocal === undefined) delete process.env.GARRISON_REMOTESHELLRUNTIME_LOCAL_SHELLS;
    else process.env.GARRISON_REMOTESHELLRUNTIME_LOCAL_SHELLS = priorLocal;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function request(headers: Record<string, string>, method = "GET", pathName = "/health"): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: pathName, method, headers }, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      });
      req.on("error", reject);
      req.end();
    });
  }

  it("OPTIONS from a trusted Origin gets 204 with the echoed CORS header", async () => {
    const r = await request({ Origin: "https://mini.tail31efa.ts.net" }, "OPTIONS");
    expect(r.status).toBe(204);
    expect(r.headers["access-control-allow-origin"]).toBe("https://mini.tail31efa.ts.net");
  });

  it("a public Origin is refused with 403", async () => {
    const r = await request({ Origin: "https://example.com" });
    expect(r.status).toBe(403);
  });

  it("no Origin (a same-origin/tool request) is served normally", async () => {
    const r = await request({});
    expect(r.status).toBe(200);
  });
});

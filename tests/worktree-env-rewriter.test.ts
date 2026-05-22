import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverEnvFiles,
  ensureWorkspacePortFiles,
  isPortKey,
  packagePortForDir,
  readMainPortMap,
  rewriteEnvFiles,
  serviceForKey
} from "@/lib/worktree/env-rewriter";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-garrison-env-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("isPortKey", () => {
  it("accepts PORT and *_PORT and PORT_* keys", () => {
    expect(isPortKey("PORT")).toBe(true);
    expect(isPortKey("API_PORT")).toBe(true);
    expect(isPortKey("CORTEX_PORT")).toBe(true);
    expect(isPortKey("PORT_HTTPS")).toBe(true);
  });

  it("rejects keys that merely contain PORT as a substring", () => {
    expect(isPortKey("PORTAL")).toBe(false);
    expect(isPortKey("REPORT")).toBe(false);
  });
});

describe("serviceForKey", () => {
  it("derives service names from common prefixes", () => {
    expect(serviceForKey("NEXT_PORT")).toBe("frontend");
    expect(serviceForKey("APP_PORT")).toBe("frontend");
    expect(serviceForKey("FRONTEND_PORT")).toBe("frontend");
    expect(serviceForKey("API_PORT")).toBe("api");
    expect(serviceForKey("PORT")).toBe("port");
  });
});

describe("packagePortForDir", () => {
  it("returns a direct match by lowercase dirname", () => {
    expect(packagePortForDir("api", { api: 51000 })).toBe(51000);
  });

  it("falls back through the alias chain", () => {
    expect(packagePortForDir("api", { backend: 51000 })).toBe(51000);
    expect(packagePortForDir("frontend", { app: 53000 })).toBe(53000);
  });

  it("returns undefined when no match", () => {
    expect(packagePortForDir("nothing", { foo: 1 })).toBeUndefined();
  });
});

describe("discoverEnvFiles", () => {
  it("finds root and first-level subdir env files", () => {
    fs.writeFileSync(path.join(tmpRoot, ".env"), "FOO=1\n");
    fs.writeFileSync(path.join(tmpRoot, ".env.local"), "BAR=2\n");
    fs.mkdirSync(path.join(tmpRoot, "api"));
    fs.writeFileSync(path.join(tmpRoot, "api", ".env"), "BAZ=3\n");
    fs.mkdirSync(path.join(tmpRoot, "node_modules"));
    fs.writeFileSync(path.join(tmpRoot, "node_modules", ".env"), "should-be-skipped\n");
    return discoverEnvFiles(tmpRoot).then((files) => {
      expect(files).toContain(".env");
      expect(files).toContain(".env.local");
      expect(files).toContain("api/.env");
      expect(files.find((f) => f.includes("node_modules"))).toBeUndefined();
    });
  });

  it("ignores dotted and skip-listed top-level dirs", () => {
    fs.mkdirSync(path.join(tmpRoot, ".git"));
    fs.writeFileSync(path.join(tmpRoot, ".git", ".env"), "x\n");
    fs.mkdirSync(path.join(tmpRoot, "dist"));
    fs.writeFileSync(path.join(tmpRoot, "dist", ".env"), "x\n");
    return discoverEnvFiles(tmpRoot).then((files) => {
      expect(files).toEqual([]);
    });
  });
});

describe("readMainPortMap", () => {
  it("maps numeric port values + URL-embedded ports to service info", () => {
    fs.writeFileSync(
      path.join(tmpRoot, ".env"),
      ["CORTEX_PORT=4321", "NEXT_PUBLIC_API_URL=http://localhost:4321/v1", ""].join("\n")
    );
    const map = readMainPortMap(tmpRoot, [".env"]);
    expect(map[4321]).toBeDefined();
    expect(map[4321].service).toBe("cortex");
  });
});

describe("rewriteEnvFiles", () => {
  it("rewrites port values + localhost URLs deterministically per branch", async () => {
    fs.writeFileSync(
      path.join(tmpRoot, ".env"),
      [
        "CORTEX_PORT=4321",
        "NEXT_PUBLIC_API_URL=http://localhost:4321/v1",
        "UNRELATED=hello",
        ""
      ].join("\n")
    );
    const map = readMainPortMap(tmpRoot, [".env"]);
    const { ports } = await rewriteEnvFiles(tmpRoot, [".env"], {
      branch: "feature/foo",
      mainPortMap: map
    });
    expect(ports.cortex).toBeDefined();
    const after = fs.readFileSync(path.join(tmpRoot, ".env"), "utf8");
    expect(after).toContain(`CORTEX_PORT=${ports.cortex}`);
    expect(after).toContain(`http://localhost:${ports.cortex}/v1`);
    expect(after).toContain("UNRELATED=hello");
  });

  it("injects PORT into per-package .env files when packagePortForDir resolves", async () => {
    fs.mkdirSync(path.join(tmpRoot, "cortex"));
    fs.writeFileSync(path.join(tmpRoot, ".env"), "CORTEX_PORT=4321\n");
    fs.writeFileSync(path.join(tmpRoot, "cortex", ".env"), "DATABASE_URL=postgres://...\n");
    const map = readMainPortMap(tmpRoot, [".env"]);
    const { ports } = await rewriteEnvFiles(tmpRoot, [".env", "cortex/.env"], {
      branch: "feature/foo",
      mainPortMap: map
    });
    const cortexEnv = fs.readFileSync(path.join(tmpRoot, "cortex", ".env"), "utf8");
    expect(cortexEnv).toMatch(/^PORT=\d+$/m);
    expect(cortexEnv).toContain(String(ports.cortex));
  });
});

describe("ensureWorkspacePortFiles", () => {
  it("creates a .env in workspace dirs that have package.json but no env", async () => {
    fs.mkdirSync(path.join(tmpRoot, "cortex"));
    fs.writeFileSync(
      path.join(tmpRoot, "cortex", "package.json"),
      JSON.stringify({ name: "cortex" }, null, 2)
    );
    const ports = { cortex: 51234 };
    const touched = await ensureWorkspacePortFiles(tmpRoot, ports);
    expect(touched).toContain("cortex/.env");
    const env = fs.readFileSync(path.join(tmpRoot, "cortex", ".env"), "utf8");
    expect(env).toContain("PORT=51234");
    expect(env).toMatch(/^# PORT injected by Garrison/m);
  });

  it("skips dirs without package.json", async () => {
    fs.mkdirSync(path.join(tmpRoot, "docs"));
    const touched = await ensureWorkspacePortFiles(tmpRoot, { docs: 51234 });
    expect(touched).toEqual([]);
  });
});

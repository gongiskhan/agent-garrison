import { describe, expect, it, afterEach } from "vitest";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { applyEnvTemplate } from "../src/lib/worktree/env-rewriter";

const dirsToClean: string[] = [];

afterEach(async () => {
  for (const dir of dirsToClean.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => null);
  }
});

async function makeWorktree(files: Record<string, string>): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "garrison-env-template-"));
  dirsToClean.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content);
  }
  return root;
}

describe("applyEnvTemplate", () => {
  it("substitutes ${ports.frontend} and ${urls.frontend} in keys that already exist", async () => {
    const root = await makeWorktree({
      ".env": "PORT=3000\nBACKEND_URL=http://localhost:9000\n"
    });

    const touched = await applyEnvTemplate(
      root,
      [".env"],
      {
        PORT: "${ports.frontend}",
        BACKEND_URL: "${urls.backend}"
      },
      { frontend: 50321, backend: 50322 },
      { frontend: "http://example:50321", backend: "http://example:50322" }
    );

    expect(touched).toEqual([".env"]);
    const updated = await fsp.readFile(path.join(root, ".env"), "utf8");
    expect(updated).toContain("PORT=50321");
    expect(updated).toContain("BACKEND_URL=http://example:50322");
  });

  it("never adds keys that did not already exist in the file (per-file scope)", async () => {
    const root = await makeWorktree({
      ".env": "PORT=3000\n",
      ".env.local": "OTHER=value\n"
    });

    const touched = await applyEnvTemplate(
      root,
      [".env", ".env.local"],
      { BACKEND_URL: "${urls.backend}" },
      { backend: 50322 },
      { backend: "http://example:50322" }
    );

    // Neither file had BACKEND_URL, so neither is touched.
    expect(touched).toEqual([]);
    expect(await fsp.readFile(path.join(root, ".env"), "utf8")).toBe("PORT=3000\n");
    expect(await fsp.readFile(path.join(root, ".env.local"), "utf8")).toBe("OTHER=value\n");
  });

  it("only touches files that contain the templated key", async () => {
    const root = await makeWorktree({
      "cortex/.env": "PORT=4000\n",
      "app/.env": "BACKEND_URL=http://localhost:4000\n"
    });

    const touched = await applyEnvTemplate(
      root,
      ["cortex/.env", "app/.env"],
      { BACKEND_URL: "${urls.cortex}" },
      { cortex: 50500 },
      { cortex: "http://example:50500" }
    );

    expect(touched).toEqual(["app/.env"]);
    expect(await fsp.readFile(path.join(root, "cortex/.env"), "utf8")).toBe("PORT=4000\n");
    expect(await fsp.readFile(path.join(root, "app/.env"), "utf8")).toContain(
      "BACKEND_URL=http://example:50500"
    );
  });

  it("skips keys with unresolvable placeholders rather than writing partial values", async () => {
    const root = await makeWorktree({ ".env": "WS_URL=ws://localhost:9000\n" });

    const touched = await applyEnvTemplate(
      root,
      [".env"],
      { WS_URL: "ws://${urls.notdefined}:8080" },
      {},
      {}
    );

    expect(touched).toEqual([]);
    expect(await fsp.readFile(path.join(root, ".env"), "utf8")).toBe("ws://localhost:9000\n".replace("ws://", "WS_URL=ws://"));
  });

  it("returns empty when the template is empty", async () => {
    const root = await makeWorktree({ ".env": "PORT=3000\n" });
    const touched = await applyEnvTemplate(root, [".env"], {}, {}, {});
    expect(touched).toEqual([]);
  });

  it("preserves leading whitespace on the substituted line", async () => {
    const root = await makeWorktree({ ".env": "  PORT=3000\n" });
    const touched = await applyEnvTemplate(
      root,
      [".env"],
      { PORT: "${ports.api}" },
      { api: 50000 },
      {}
    );
    expect(touched).toEqual([".env"]);
    expect(await fsp.readFile(path.join(root, ".env"), "utf8")).toBe("  PORT=50000\n");
  });
});

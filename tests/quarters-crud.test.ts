import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runQuartersAction, type CrudResult } from "@/lib/quarters";
import { getPrimitiveDetail } from "@/lib/quarters-detail";

let claudeRoot: string;
let priorClaude: string | undefined;

beforeEach(() => {
  priorClaude = process.env.GARRISON_CLAUDE_HOME;
  claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gar-qcrud-"));
  process.env.GARRISON_CLAUDE_HOME = claudeRoot;
});
afterEach(() => {
  if (priorClaude === undefined) delete process.env.GARRISON_CLAUDE_HOME;
  else process.env.GARRISON_CLAUDE_HOME = priorClaude;
  fs.rmSync(claudeRoot, { recursive: true, force: true });
});

describe("runQuartersAction — MCP CRUD dispatch", () => {
  it("add → detail → update → remove round-trip via the dispatch", async () => {
    const add = (await runQuartersAction({ action: "mcp.add", name: "ctx", config: { command: "npx" } })) as CrudResult;
    expect(add.ok).toBe(true);
    expect(add.id).toBe("mcp:ctx");

    const detail = await getPrimitiveDetail("mcp:ctx");
    expect(detail).toEqual({ surface: "mcp", name: "ctx", config: { command: "npx" } });

    const upd = (await runQuartersAction({
      action: "mcp.update",
      name: "ctx",
      newName: "context7",
      config: { command: "npx", args: ["-y", "ctx"] }
    })) as CrudResult;
    expect(upd.ok).toBe(true);
    expect(upd.id).toBe("mcp:context7");

    const rm = (await runQuartersAction({ action: "mcp.remove", name: "context7" })) as CrudResult;
    expect(rm.ok).toBe(true);

    const gone = await getPrimitiveDetail("mcp:context7");
    expect(gone).toEqual({ surface: "mcp", name: "context7", config: null });
  });

  it("surfaces a CrudResult error (exists) without throwing", async () => {
    await runQuartersAction({ action: "mcp.add", name: "dup", config: { command: "a" } });
    const again = (await runQuartersAction({ action: "mcp.add", name: "dup", config: { command: "b" } })) as CrudResult;
    expect(again.ok).toBe(false);
    expect(again.code).toBe("exists");
  });

  it("rejects an unknown action", async () => {
    await expect(
      runQuartersAction({ action: "nope" } as unknown as Parameters<typeof runQuartersAction>[0])
    ).rejects.toThrow(/unknown quarters action/);
  });
});

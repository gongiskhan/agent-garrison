import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fittingSharingInfo } from "@/lib/fitting-sharing";
import type { Composition, LibraryEntry } from "@/lib/types";
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "fitting-sharing-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
const runtime = (id: string, name: string) => ({ id, metadata: { provides: [{ kind: "runtime", name }] } }) as LibraryEntry;
const comp = { selections: { memory: [{ id: "memory", config: {}, shared: ["claude-code"] }], runtimes: [{ id: "sdk", config: {} }, { id: "codex", config: {} }] } } as Composition;
describe("fitting sharing availability", () => {
  it("offers only equipped engines and detects native registration targets", async () => {
    await fs.mkdir(path.join(root, "scripts"));
    await fs.writeFile(path.join(root, "scripts", "setup.mjs"), "const home = process.env.CODEX_HOME");
    const entry = { id: "memory", localPath: root, metadata: { provides: [], setup: [{ command: "node scripts/setup.mjs" }], shared_default: ["claude-code"] } } as unknown as LibraryEntry;
    expect(await fittingSharingInfo(entry, comp, [runtime("sdk", "agent-sdk"), runtime("codex", "codex")])).toEqual({ runtimes: ["claude-code", "codex"], shared: ["claude-code"], available: { "claude-code": true, codex: true, gemini: false } });
  });
  it("disables runtimes without primitives", async () => {
    const entry = { id: "memory", localPath: root, metadata: { provides: [] } } as unknown as LibraryEntry;
    const info = await fittingSharingInfo(entry, comp, [runtime("sdk", "agent-sdk"), runtime("codex", "codex")]);
    expect(Object.values(info.available)).toEqual([false, false, false]);
    await fs.mkdir(path.join(root, ".apm", "skills"), { recursive: true });
    expect((await fittingSharingInfo(entry, comp, [])).available["claude-code"]).toBe(true);
  });
});

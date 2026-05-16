import { describe, expect, it, afterEach } from "vitest";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const LIB = path.resolve(__dirname, "..", "fittings", "seed", "http-gateway", "scripts", "lib");

const tmpFiles: string[] = [];

afterEach(async () => {
  for (const file of tmpFiles.splice(0)) {
    await fsp.unlink(file).catch(() => null);
  }
});

async function makeTmpJsonl(lines: object[]): Promise<string> {
  const file = path.join(os.tmpdir(), `garrison-jsonl-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  await fsp.writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  tmpFiles.push(file);
  return file;
}

describe("Phase 9I L1 — jsonl-watcher / extractLastAssistantText", () => {
  it("returns the text of the most recent assistant message", async () => {
    const mod = await import(path.join(LIB, "jsonl-watcher.mjs"));
    const file = await makeTmpJsonl([
      { type: "user", message: { role: "user", content: "hi" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "first reply" }] } },
      { type: "user", message: { role: "user", content: "and again?" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "second reply" }] } }
    ]);
    const summary = await mod.extractLastAssistantText(file);
    expect(summary).toBe("second reply");
  });

  it("joins multiple text blocks within a single assistant message", async () => {
    const mod = await import(path.join(LIB, "jsonl-watcher.mjs"));
    const file = await makeTmpJsonl([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Part 1" },
            { type: "tool_use", name: "Read", input: {} }, // ignored
            { type: "text", text: "Part 2" }
          ]
        }
      }
    ]);
    const summary = await mod.extractLastAssistantText(file);
    expect(summary).toBe("Part 1\nPart 2");
  });

  it("walks back past assistant messages that only contain tool_use to find the latest text", async () => {
    const mod = await import(path.join(LIB, "jsonl-watcher.mjs"));
    const file = await makeTmpJsonl([
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: {} }] } }
    ]);
    const summary = await mod.extractLastAssistantText(file);
    expect(summary).toBe("hello");
  });

  it("returns null for an empty file", async () => {
    const mod = await import(path.join(LIB, "jsonl-watcher.mjs"));
    const file = await makeTmpJsonl([]);
    const summary = await mod.extractLastAssistantText(file);
    expect(summary).toBeNull();
  });

  it("skips malformed JSON lines without throwing", async () => {
    const mod = await import(path.join(LIB, "jsonl-watcher.mjs"));
    const file = path.join(os.tmpdir(), `garrison-jsonl-malformed-${Date.now()}.jsonl`);
    tmpFiles.push(file);
    await fsp.writeFile(
      file,
      [
        "not json at all",
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "real" }] } }),
        "{ broken"
      ].join("\n")
    );
    const summary = await mod.extractLastAssistantText(file);
    expect(summary).toBe("real");
  });

  it("projectDirForCwd keeps the leading dash (per Spike F)", async () => {
    const mod = await import(path.join(LIB, "jsonl-watcher.mjs"));
    expect(mod.projectDirForCwd("/Users/ggomes/Projects/agent-garrison"))
      .toBe("-Users-ggomes-Projects-agent-garrison");
  });
});

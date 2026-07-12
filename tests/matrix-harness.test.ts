import { describe, it, expect } from "vitest";
// @ts-ignore — pure .mjs harness (exports are pure, no live boot at import)
import { classifyAction, renderMatrix } from "../scripts/matrix-harness.mjs";

// S2c — unit coverage for the runtime-agnosticism matrix harness's PURE layer:
// the per-fitting representative-action classifier and the markdown renderer.
// The live boot/turn/verify paths are exercised by the committed run itself
// (docs/RUNTIME_MATRIX.md + matrix-cells.json), not here.

const fit = (id: string, faculty: string, xg: Record<string, unknown>) => ({
  id,
  faculty,
  manifest: { "x-garrison": { faculty, ...xg } }
});

describe("matrix-harness classifyAction (S2c)", () => {
  it("gateway faculty → gateway-boot (the column's own boot is the action)", () => {
    expect(classifyAction(fit("http-gateway", "gateway", {})).type).toBe("gateway-boot");
  });

  it("a runtime provider → runtime-delegate carrying the engine name", () => {
    const a = classifyAction(fit("opencode-runtime", "runtimes", { provides: [{ kind: "runtime", name: "opencode" }] }));
    expect(a).toEqual({ type: "runtime-delegate", engine: "opencode" });
  });

  it("memory-store → memory-read", () => {
    expect(classifyAction(fit("basic-memory", "memory", { provides: [{ kind: "memory-store", name: "basic-memory" }] })).type).toBe("memory-read");
  });

  it("a connector catalog → catalog-parse (BEFORE own-port health)", () => {
    const a = classifyAction(
      fit("deepgram-voice", "connectors", {
        own_port: true,
        provides: [{ kind: "voice", name: "deepgram" }, { kind: "connector", name: "deepgram" }],
        connector: { actions: [{ name: "transcribe", mutates: false }] }
      })
    );
    expect(a.type).toBe("catalog-parse");
  });

  it("own_port without a connector → http-health", () => {
    expect(classifyAction(fit("monitor-default", "observability", { own_port: true, provides: [{ kind: "monitor", name: "monitor" }] })).type).toBe("http-health");
  });

  it("everything else → manifest", () => {
    expect(classifyAction(fit("modes", "modes", { provides: [{ kind: "modes", name: "modes" }] })).type).toBe("manifest");
    expect(classifyAction(fit("taste", "design", {})).type).toBe("manifest");
  });

  it("a runtime provider wins over own_port + connector (priority order)", () => {
    const a = classifyAction(
      fit("weird", "runtimes", { own_port: true, provides: [{ kind: "runtime", name: "x" }], connector: { actions: [{ name: "y" }] } })
    );
    expect(a.type).toBe("runtime-delegate");
  });
});

describe("matrix-harness renderMatrix (S2c)", () => {
  const cache = {
    runAt: "2026-07-12T21:00:00.000Z",
    env: { node: "v20", opencode: "1.17.15", codex: "authed", claude: "/bin/claude", ollama: "up (qwen2.5:3b)" },
    order: ["opencode", "codex"],
    fittingOrder: ["http-gateway", "gemini-runtime", "trello"],
    fittingMeta: {
      "http-gateway": { faculty: "gateway", action: "gateway-boot" },
      "gemini-runtime": { faculty: "runtimes", action: "runtime-delegate" },
      trello: { faculty: "connectors", action: "catalog-parse" }
    },
    primaries: {
      opencode: {
        boot: { status: "pass", engine: "opencode", reply: "pong", note: "booted + served one turn" },
        cells: {
          "http-gateway": { status: "pass", note: "booted" },
          "gemini-runtime": { status: "degraded", note: "unauthed on this box" },
          trello: { status: "pass", note: "catalog parsed: 5 actions" }
        }
      },
      codex: {
        boot: { status: "pass", engine: "codex", reply: "pong", note: "booted + served one turn" },
        cells: {
          "http-gateway": { status: "pass", note: "booted" },
          "gemini-runtime": { status: "degraded", note: "unauthed on this box" },
          trello: { status: "pass", note: "catalog parsed: 5 actions" }
        }
      }
    }
  };

  it("renders the header, boot table, matrix, counts, degradations, and a zero-fail verdict", () => {
    const md = renderMatrix(cache);
    expect(md).toContain("# Runtime-agnosticism matrix");
    expect(md).toContain("## Primary boot + one served turn");
    expect(md).toContain("## Every fitting under every primary");
    // both primary columns appear as headers
    expect(md).toContain("`opencode`");
    expect(md).toContain("`codex`");
    // the degraded gemini cell is surfaced with its cause
    expect(md).toContain("gemini-runtime @ opencode");
    expect(md).toContain("unauthed on this box");
    // no fail cells anywhere → the ZERO verdict
    expect(md).toContain("**ZERO.**");
  });

  it("counts a fail cell and flips the unexplained-failures verdict", () => {
    const withFail = structuredClone(cache);
    withFail.primaries.opencode.cells.trello = { status: "fail", note: "catalog missing" };
    const md = renderMatrix(withFail);
    expect(md).toContain("trello @ opencode");
    expect(md).not.toContain("**ZERO.**");
    expect(md).toMatch(/\*\*1\*\* - see the fail rows/);
  });
});

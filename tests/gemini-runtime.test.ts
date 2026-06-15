import { describe, it, expect } from "vitest";
// @ts-ignore
import { GeminiAdapter, buildArgs, scrapeArtifactPaths } from "../fittings/seed/gemini-runtime/lib/gemini-adapter.mjs";
// @ts-ignore
import { delegate, validateDelegationResult, runAdapterConformance } from "../packages/claude-pty/src/index.mjs";

describe("Gemini runtime adapter (MRr-gemini)", () => {
  it("buildArgs: gemini -m <model> -y -p '' (headless), prompt via STDIN (never argv)", () => {
    const { bin, argv, stdinFromPrompt } = buildArgs({ model: "gemini-2.5-flash" });
    expect(bin).toBe("gemini");
    expect(argv).toContain("-m");
    expect(argv).toContain("gemini-2.5-flash");
    expect(argv).toContain("-y");
    expect(argv).toContain("--skip-trust"); // trust the throwaway workspace (verified live U4)
    expect(argv).toContain("-p");
    expect(stdinFromPrompt).toBe(true);
    expect(argv.join(" ")).not.toContain("generate a logo");
  });

  it("scrapeArtifactPaths pulls image paths out of output", () => {
    expect(scrapeArtifactPaths("Saved to /tmp/out/logo.png and /tmp/out/banner.jpg")).toEqual(["/tmp/out/logo.png", "/tmp/out/banner.jpg"]);
    expect(scrapeArtifactPaths("no files here")).toEqual([]);
  });

  it("passes the RuntimeAdapter conformance harness (stub exec)", async () => {
    const adapter = new GeminiAdapter({ runExec: async () => ({ code: 0, stdout: "ok", stderr: "" }) });
    const report = await runAdapterConformance(adapter, { config: { compositionDir: "/tmp/x", model: "gemini-2.5-flash" }, turnText: "ping" });
    expect(report.ok).toBe(true);
    expect(report.runtime).toBe("gemini");
  });

  it("feeds the prompt to gemini via stdin, never argv", async () => {
    let seen = "";
    const adapter = new GeminiAdapter({
      runExec: async ({ stdin, argv }: any) => {
        seen = stdin;
        expect(argv.join(" ")).not.toContain("generate a logo");
        return { code: 0, stdout: "saved to /art/logo.png", stderr: "" };
      }
    });
    const s = await adapter.spawn({ model: "gemini-2.5-flash" });
    await adapter.sendTurn(s, "generate a logo");
    const r = await adapter.awaitResponse(s);
    expect(seen).toContain("generate a logo");
    expect(r.artifacts).toContain("/art/logo.png");
  });
});

describe("Gemini image delegation (MRr-gemini — gemini-runtime-ok)", () => {
  it("the primary delegates an image task to the Gemini runtime and receives the image artifact path", async () => {
    const logged: any[] = [];
    const written: any[] = [];
    const adapter = new GeminiAdapter({ runExec: async () => ({ code: 0, stdout: "Image generated → /workspace/out/logo.png", stderr: "" }) });
    const result = await delegate(
      { task: "generate a logo for Garrison", model: "gemini-2.5-flash" },
      {
        adapter,
        spawnConfig: { compositionDir: "/workspace", model: "gemini-2.5-flash" },
        writeArtifact: async (ns: string, name: string, content: string) => {
          written.push({ ns, name, content });
          return `artifacts/${ns}/${name}`;
        },
        logDecision: async (rec: any) => logged.push(rec),
        secrets: {},
        now: () => "2026-06-14T00:00:00Z"
      },
      { modelAllowlist: /^gemini/i }
    );
    expect(validateDelegationResult(result)).toEqual([]);
    // the scraped image path is among the returned artifacts (gemini-runtime-ok)
    expect(result.artifacts).toContain("/workspace/out/logo.png");
    expect(logged[0]).toMatchObject({ kind: "delegation", runtime: "gemini" });
  });
});

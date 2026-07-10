import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileRoutingMarkdown,
  parseClassifierReply,
  readRoutingConfig,
  replyRouteToken,
  resolveRoute
} from "@/lib/model-router";

const CONFIG = path.resolve(__dirname, "..", "fittings", "seed", "orchestrator", "routing.json");

describe("model router config/compiler", () => {
  it("compiles the seed active profile with the routing marker and continuations", async () => {
    const config = await readRoutingConfig(CONFIG);
    const compiled = compileRoutingMarkdown(config);
    expect(compiled).toContain("<!-- garrison:routing v1 profile=balanced -->");
    expect(compiled).toContain("## Continuations");
    expect(compiled).toContain("store-memory");
  });

  it("profiles compile to different byte-stable policies", async () => {
    const config = await readRoutingConfig(CONFIG);
    const balancedA = compileRoutingMarkdown(config, "balanced");
    const balancedB = compileRoutingMarkdown(config, "balanced");
    const economy = compileRoutingMarkdown(config, "economy");
    expect(balancedA).toBe(balancedB);
    expect(economy).not.toBe(balancedA);
    expect(economy).toContain("profile=economy");
  });

  it("resolves exception, cell, inheritance, and default routes", async () => {
    const config = await readRoutingConfig(CONFIG);
    const exception = resolveRoute(config, { taskType: "review", tier: "T1-standard" }, "balanced", "security review");
    expect(exception.target.id).toBe("native-opus-high");
    expect(exception.matchedRule).toBe("exception-security-review");

    const cell = resolveRoute(config, { taskType: "code", tier: "T1-standard" }, "balanced", "implement feature");
    expect(cell.target.id).toBe("native-sonnet-medium");
    expect(cell.matchedRule).toBe("cell:balanced:code:T1-standard");

    const inherited = resolveRoute(config, { taskType: "video", tier: "T2-deep" }, "economy", "record walkthrough");
    expect(inherited.target.id).toBe("workflow-memory-consolidation");
    expect(inherited.matchedRule).toContain("inherit:economy");

    const minimal = {
      ...config,
      activeProfile: "minimal",
      profiles: [
        {
          id: "minimal",
          label: "Minimal",
          defaultTarget: "native-haiku-low",
          discipline: config.profiles[0].discipline,
          continuations: []
        }
      ]
    };
    const fallback = resolveRoute(minimal, { taskType: "other", tier: "T2-deep" }, "minimal", "unknown");
    expect(fallback.target.id).toBe("native-haiku-low");
    expect(fallback.matchedRule).toBe("default:minimal");
  });

  it("parses classifier JSON and formats the route token", async () => {
    const config = await readRoutingConfig(CONFIG);
    const classification = parseClassifierReply('{"taskType":"code","tier":"T0-trivial"}');
    const route = resolveRoute(config, classification, "balanced", "fix typo");
    expect(replyRouteToken(route)).toBe("[route: native-haiku-low | rule: cell:balanced:code:T0-trivial | profile: balanced]");
  });

  it("has no SDK or stream-json fallback in the model-router fitting", async () => {
    const files = await fs.readdir(path.dirname(CONFIG), { recursive: true });
    const text = await Promise.all(
      files
        .filter((file) => typeof file === "string" && !file.includes("node_modules"))
        .map(async (file) => fs.readFile(path.join(path.dirname(CONFIG), String(file)), "utf8").catch(() => ""))
    );
    expect(text.join("\n")).not.toContain("@anthropic-ai");
    expect(text.join("\n")).not.toContain("api.anthropic.com");
  });
});

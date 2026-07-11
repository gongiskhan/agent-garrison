import { describe, expect, it } from "vitest";
import { parseGarrisonMetadata, validateSelection } from "@/lib/metadata";

const baseMetadata = {
  faculty: "memory" as const,
  cardinality_hint: "single" as const,
  component_shape: "skill" as const,
  platforms: ["claude-code"],
  verify: { command: "echo ok", expect: "ok" }
};

describe("x-garrison metadata", () => {
  it("accepts a valid role package", () => {
    const metadata = parseGarrisonMetadata({
      ...baseMetadata,
      config_schema: [
        {
          key: "recency_window",
          type: "integer",
          default: 20,
          description: "Recency window"
        }
      ]
    });

    expect(metadata.verify.timeout_ms).toBe(10000);
  });

  it("rejects shape mismatches at compose time", () => {
    expect(() =>
      parseGarrisonMetadata({
        ...baseMetadata,
        component_shape: "script"
      })
    ).toThrow(/not accepted/);
  });

  it("rejects too many single-cardinality selections", () => {
    // memory became a multi role when trello-data-source rejoined it
    // (2026-06-10), so the single-cardinality case uses orchestrator.
    const metadata = parseGarrisonMetadata({
      ...baseMetadata,
      faculty: "orchestrator",
      component_shape: "system-prompt"
    });

    expect(() => validateSelection("orchestrator", 2, [metadata, metadata])).toThrow(/accepts one/);
  });

  it("accepts the deprecated `primitive` alias and normalizes to `faculty`", () => {
    const warn = console.warn;
    const calls: unknown[] = [];
    console.warn = (...args: unknown[]) => calls.push(args);
    try {
      const metadata = parseGarrisonMetadata({
        primitive: "memory",
        cardinality_hint: "single",
        component_shape: "skill",
        platforms: ["claude-code"],
        verify: { command: "echo ok", expect: "ok" }
      });
      expect(metadata.faculty).toBe("memory");
      expect(calls.length).toBeGreaterThan(0);
    } finally {
      console.warn = warn;
    }
  });

  // (The deprecated `data-sources` faculty alias + the `data-source` kind were
  // dropped 2026-06-26 — superseded by the `connectors` faculty + `connector`
  // kind. Trello is now the `trello` connector. See connector-*.test.ts.)

  it("folds a deprecated own-port faculty into its role (terminal -> sessions)", () => {
    const warn = console.warn;
    const calls: unknown[] = [];
    console.warn = (...args: unknown[]) => calls.push(args);
    try {
      const metadata = parseGarrisonMetadata({
        faculty: "terminal",
        cardinality_hint: "single",
        component_shape: "plugin",
        platforms: ["claude-code"],
        own_port: true,
        verify: { command: "echo ok", expect: "ok" }
      });
      expect(metadata.faculty).toBe("sessions");
      expect(metadata.own_port).toBe(true);
      expect(calls.length).toBeGreaterThan(0);
    } finally {
      console.warn = warn;
    }
  });

  it("warns about both deprecations when a manifest uses primitive: monitor", () => {
    const warn = console.warn;
    const calls: unknown[] = [];
    console.warn = (...args: unknown[]) => calls.push(args);
    try {
      const metadata = parseGarrisonMetadata({
        primitive: "monitor",
        cardinality_hint: "single",
        component_shape: "plugin",
        platforms: ["claude-code"],
        verify: { command: "echo ok", expect: "ok" }
      });
      expect(metadata.faculty).toBe("observability");
      expect(calls.length).toBe(2);
    } finally {
      console.warn = warn;
    }
  });
});

describe("ui contract v2 — views[]", () => {
  it("parses a v2 manifest with multiple views and placements", () => {
    const metadata = parseGarrisonMetadata({
      ...baseMetadata,
      ui: {
        views: [
          { id: "list", placement: "faculty-tab", entry: "./ui/list.tsx", route: "/" },
          { id: "read", placement: "sidebar-surface", entry: "./ui/read.tsx", route: "/:id" }
        ]
      }
    });
    expect(metadata.ui?.views).toHaveLength(2);
    expect(metadata.ui?.views[0]).toEqual({
      id: "list",
      placement: "faculty-tab",
      entry: "./ui/list.tsx",
      route: "/"
    });
  });

  it("normalizes the deprecated ui.extension into a single faculty-tab view", () => {
    const warn = console.warn;
    const calls: unknown[] = [];
    console.warn = (...args: unknown[]) => calls.push(args);
    try {
      const metadata = parseGarrisonMetadata({
        ...baseMetadata,
        ui: { extension: "./ui/Inspector.tsx" }
      });
      expect(metadata.ui?.views).toEqual([
        {
          id: "main",
          placement: "faculty-tab",
          entry: "./ui/Inspector.tsx",
          route: "/"
        }
      ]);
      expect(calls.length).toBe(1);
    } finally {
      console.warn = warn;
    }
  });

  it("rejects an unknown placement value", () => {
    expect(() =>
      parseGarrisonMetadata({
        ...baseMetadata,
        ui: {
          views: [
            { id: "x", placement: "modal", entry: "./ui/x.tsx", route: "/" }
          ]
        }
      })
    ).toThrow();
  });

  it("rejects an empty views array", () => {
    expect(() =>
      parseGarrisonMetadata({ ...baseMetadata, ui: { views: [] } })
    ).toThrow(/at least one view/);
  });

  it("rejects view ids that do not match the slug pattern", () => {
    expect(() =>
      parseGarrisonMetadata({
        ...baseMetadata,
        ui: {
          views: [
            { id: "1bad", placement: "faculty-tab", entry: "./ui/x.tsx", route: "/" }
          ]
        }
      })
    ).toThrow();
  });
});

describe("for_consumers field", () => {
  it("parses when a Fitting ships a for_consumers block", () => {
    const metadata = parseGarrisonMetadata({
      ...baseMetadata,
      for_consumers: "Use this Faculty when in PM hat."
    });
    expect(metadata.for_consumers).toBe("Use this Faculty when in PM hat.");
  });

  it("is optional", () => {
    const metadata = parseGarrisonMetadata({ ...baseMetadata });
    expect(metadata.for_consumers).toBeUndefined();
  });

  it("rejects values that exceed the 8 KB byte cap", () => {
    const oversized = "x".repeat(8 * 1024 + 1);
    expect(() =>
      parseGarrisonMetadata({ ...baseMetadata, for_consumers: oversized })
    ).toThrow(/for_consumers exceeds/);
  });
});

describe("capability provides/consumes", () => {
  it("defaults provides and consumes to empty arrays when absent", () => {
    const metadata = parseGarrisonMetadata({ ...baseMetadata });
    expect(metadata.provides).toEqual([]);
    expect(metadata.consumes).toEqual([]);
  });

  it("accepts a valid provides entry", () => {
    const metadata = parseGarrisonMetadata({
      ...baseMetadata,
      provides: [{ kind: "memory-store", name: "garrison-memory" }]
    });
    expect(metadata.provides).toEqual([{ kind: "memory-store", name: "garrison-memory" }]);
  });

  it("accepts a valid consumes entry", () => {
    const metadata = parseGarrisonMetadata({
      ...baseMetadata,
      consumes: [{ kind: "orchestrator", cardinality: "one" }]
    });
    expect(metadata.consumes).toEqual([{ kind: "orchestrator", cardinality: "one" }]);
  });

  it("accepts both provides and consumes together", () => {
    const metadata = parseGarrisonMetadata({
      ...baseMetadata,
      provides: [{ kind: "memory-store", name: "garrison-memory" }],
      consumes: [{ kind: "vault", cardinality: "optional-one" }]
    });
    expect(metadata.provides).toHaveLength(1);
    expect(metadata.consumes).toHaveLength(1);
  });

  it("rejects a dropped capability kind (agent-skill was removed in the pivot)", () => {
    expect(() =>
      parseGarrisonMetadata({
        ...baseMetadata,
        provides: [{ kind: "agent-skill", name: "x" }]
      })
    ).toThrow(/agent-skill/);
  });

  it("rejects an unknown capability kind by name", () => {
    expect(() =>
      parseGarrisonMetadata({
        ...baseMetadata,
        provides: [{ kind: "channel-host", name: "slack" }]
      })
    ).toThrow(/channel-host/);
  });

  it("rejects a provides entry without a name", () => {
    expect(() =>
      parseGarrisonMetadata({
        ...baseMetadata,
        provides: [{ kind: "memory-store" }]
      })
    ).toThrow();
  });

  it("rejects a consumes entry with an invalid cardinality", () => {
    expect(() =>
      parseGarrisonMetadata({
        ...baseMetadata,
        consumes: [{ kind: "orchestrator", cardinality: "many" }]
      })
    ).toThrow();
  });
});

describe("setup as ordered steps", () => {
  it("normalises a single setup step into a one-element array (back-compat)", () => {
    const metadata = parseGarrisonMetadata({
      ...baseMetadata,
      setup: { command: "bash scripts/setup.sh", idempotent: true, timeout_ms: 15000 }
    });
    expect(Array.isArray(metadata.setup)).toBe(true);
    expect(metadata.setup).toHaveLength(1);
    expect(metadata.setup?.[0]).toMatchObject({
      command: "bash scripts/setup.sh",
      idempotent: true,
      timeout_ms: 15000
    });
  });

  it("accepts an ordered array of setup steps and preserves order + labels", () => {
    const metadata = parseGarrisonMetadata({
      ...baseMetadata,
      setup: [
        { command: "npm i -g @playwright/test", label: "Install the Playwright CLI" },
        { command: "playwright install chromium", label: "Install the browser" }
      ]
    });
    expect(metadata.setup).toHaveLength(2);
    expect(metadata.setup?.[0]?.label).toBe("Install the Playwright CLI");
    expect(metadata.setup?.[1]?.command).toBe("playwright install chromium");
    // idempotent defaults to true when omitted.
    expect(metadata.setup?.[0]?.idempotent).toBe(true);
  });

  it("rejects an empty setup array", () => {
    expect(() => parseGarrisonMetadata({ ...baseMetadata, setup: [] })).toThrow();
  });

  it("leaves setup undefined when absent", () => {
    const metadata = parseGarrisonMetadata({ ...baseMetadata });
    expect(metadata.setup).toBeUndefined();
  });
});

// D3/D5 (GARRISON-RUNTIMES-V1): runtime Fittings declare a provider mechanism
// and a Quarters descriptor. Both are optional, both are STRICT — a typo'd or
// unknown key inside them is a manifest bug and must fail the parse loudly,
// never be silently dropped.
describe("provider_mechanism block (D3)", () => {
  const runtimeBase = {
    ...baseMetadata,
    faculty: "runtimes" as const,
    component_shape: "cli-skill" as const,
    provides: [{ kind: "runtime", name: "claude-code" }]
  };

  it("parses an env mechanism", () => {
    const m = parseGarrisonMetadata({
      ...runtimeBase,
      provider_mechanism: {
        type: "env",
        base_url_env: "ANTHROPIC_BASE_URL",
        auth_env: "ANTHROPIC_AUTH_TOKEN",
        model_arg: "--model"
      }
    });
    expect(m.provider_mechanism?.type).toBe("env");
    expect(m.provider_mechanism?.base_url_env).toBe("ANTHROPIC_BASE_URL");
  });

  it("parses a config-file mechanism (codex shape)", () => {
    const m = parseGarrisonMetadata({
      ...runtimeBase,
      provides: [{ kind: "runtime", name: "codex" }],
      provider_mechanism: {
        type: "config-file",
        config_file: "~/.codex/config.toml",
        config_format: "toml",
        config_key: "model_providers",
        model_key: "model"
      }
    });
    expect(m.provider_mechanism?.config_format).toBe("toml");
  });

  it("is optional (a runtime with no mechanism is still a target)", () => {
    const m = parseGarrisonMetadata(runtimeBase);
    expect(m.provider_mechanism).toBeUndefined();
  });

  it("rejects an unknown key inside the block (strict, loud)", () => {
    expect(() =>
      parseGarrisonMetadata({
        ...runtimeBase,
        provider_mechanism: { type: "env", base_url_env: "X", bogus_key: "y" }
      })
    ).toThrow(/bogus_key|unrecognized/i);
  });

  it("rejects an env mechanism that declares no override channel at all", () => {
    expect(() =>
      parseGarrisonMetadata({ ...runtimeBase, provider_mechanism: { type: "env" } })
    ).toThrow(/declares none/);
  });

  it("rejects a config-file mechanism without config_file + config_format", () => {
    expect(() =>
      parseGarrisonMetadata({
        ...runtimeBase,
        provider_mechanism: { type: "config-file", config_key: "model_providers" }
      })
    ).toThrow(/requires config_file and config_format/);
  });
});

describe("quarters_descriptor block (D5)", () => {
  const runtimeBase = {
    ...baseMetadata,
    faculty: "runtimes" as const,
    component_shape: "cli-skill" as const,
    provides: [{ kind: "runtime", name: "codex" }]
  };

  it("parses a deep descriptor (claude-code maps to the registered deep implementation)", () => {
    const m = parseGarrisonMetadata({
      ...runtimeBase,
      provides: [{ kind: "runtime", name: "claude-code" }],
      quarters_descriptor: { tier: "deep", id: "claude-code" }
    });
    expect(m.quarters_descriptor).toEqual({ tier: "deep", id: "claude-code" });
  });

  it("parses a generic descriptor with native config surfaces", () => {
    const m = parseGarrisonMetadata({
      ...runtimeBase,
      quarters_descriptor: {
        tier: "generic",
        id: "codex",
        home_dir: "~/.codex",
        settings_files: [{ path: "~/.codex/config.toml", format: "toml" }],
        context_file: "AGENTS.md",
        mcp_config: { path: "~/.codex/config.toml", format: "toml", key: "mcp_servers" },
        log_paths: ["~/.codex/log"]
      }
    });
    expect(m.quarters_descriptor?.home_dir).toBe("~/.codex");
    expect(m.quarters_descriptor?.settings_files?.[0].format).toBe("toml");
  });

  it("rejects a generic descriptor without home_dir (loud, never a silent fallback)", () => {
    expect(() =>
      parseGarrisonMetadata({
        ...runtimeBase,
        quarters_descriptor: { tier: "generic", id: "codex" }
      })
    ).toThrow(/requires home_dir/);
  });

  it("rejects unknown keys inside the descriptor (strict, loud)", () => {
    expect(() =>
      parseGarrisonMetadata({
        ...runtimeBase,
        quarters_descriptor: { tier: "deep", id: "claude-code", surprise: true }
      })
    ).toThrow(/surprise|unrecognized/i);
  });

  it("rejects a non-kebab-case descriptor id", () => {
    expect(() =>
      parseGarrisonMetadata({
        ...runtimeBase,
        quarters_descriptor: { tier: "deep", id: "Claude Code" }
      })
    ).toThrow(/kebab-case/);
  });
});

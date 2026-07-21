import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  capabilitiesPlaceholderWarning,
  MISSING_CAPABILITIES_PLACEHOLDER_WARNING,
  renderCapabilitiesBlock,
  substituteCapabilitiesPlaceholder
} from "@/lib/runner";
import type { LibraryEntry, GarrisonMetadata } from "@/lib/types";

const REPO_ROOT = path.resolve(__dirname, "..");

function entry(
  id: string,
  faculty: GarrisonMetadata["faculty"],
  shape: GarrisonMetadata["component_shape"],
  cardinalityHint: GarrisonMetadata["cardinality_hint"],
  provides: GarrisonMetadata["provides"],
  summary: string,
  forConsumers?: string
): LibraryEntry {
  const metadata: GarrisonMetadata = {
    faculty,
    cardinality_hint: cardinalityHint,
    component_shape: shape,
    platforms: ["claude-code"],
    summary,
    for_consumers: forConsumers,
    config_schema: [],
    provides,
    consumes: [],
    verify: { command: "echo ok", expect: "ok", timeout_ms: 10000 }
  };
  return {
    id,
    name: id,
    faculty,
    repo: `local:fittings/seed/${id}`,
    summary,
    platforms: ["claude-code"],
    ratings: {},
    metadata
  };
}

describe("renderCapabilitiesBlock", () => {
  it("renders an empty placeholder when no provider Fittings are present", () => {
    const block = renderCapabilitiesBlock([]);
    expect(block).toContain("no Faculties currently installed");
  });

  it("lists kind:name with each Fitting's summary, sorted by kind then name", () => {
    const entries = [
      entry(
        "trello",
        "memory",
        "cli",
        "multi",
        [{ kind: "connector", name: "trello" }],
        "Trello board access"
      ),
      entry(
        "slack-channel",
        "channels",
        "script",
        "multi",
        [{ kind: "channel", name: "slack" }],
        "Slack inbound/outbound"
      )
    ];
    const block = renderCapabilitiesBlock(entries);
    expect(block).toContain("- channel:slack — Slack inbound/outbound");
    expect(block).toContain("- connector:trello — Trello board access");
    const channelIdx = block.indexOf("channel:slack");
    const dataIdx = block.indexOf("connector:trello");
    expect(channelIdx).toBeLessThan(dataIdx);
  });

  it("renders the for_consumers body indented under the provider line when present", () => {
    const docs = entry(
      "documents",
      "sessions",
      "cli-skill",
      "single",
      [{ kind: "channel", name: "project-documents" }],
      "Documents workspace",
      "Use the Documents Faculty when in PM hat.\n- bullet one\n- bullet two"
    );
    const block = renderCapabilitiesBlock([docs]);
    expect(block).toContain("- channel:project-documents — Documents workspace");
    expect(block).toContain("  Use the Documents Faculty when in PM hat.");
    expect(block).toContain("  - bullet one");
    expect(block).toContain("  - bullet two");
  });

  it("falls back to the summary line when for_consumers is absent", () => {
    const trello = entry(
      "trello",
      "memory",
      "cli",
      "multi",
      [{ kind: "connector", name: "trello" }],
      "Trello board access"
    );
    const block = renderCapabilitiesBlock([trello]);
    expect(block).toBe("- connector:trello — Trello board access");
  });

  it("separates entries with a blank line when any provider ships for_consumers", () => {
    const trello = entry(
      "trello",
      "memory",
      "cli",
      "multi",
      [{ kind: "connector", name: "trello" }],
      "Trello board access"
    );
    const docs = entry(
      "documents",
      "sessions",
      "cli-skill",
      "single",
      [{ kind: "channel", name: "project-documents" }],
      "Documents workspace",
      "Use this when capturing decisions."
    );
    const block = renderCapabilitiesBlock([trello, docs]);
    // Sorted by kind: channel comes before connector. The blank line
    // separator only kicks in once at least one provider ships for_consumers.
    expect(block).toContain(
      "  Use this when capturing decisions.\n\n- connector:trello — Trello board access"
    );
  });

  it("includes a derived view provider's for_consumers when it declares no provides (own_port surface)", () => {
    // The file-browser pattern: provides: [] but an own-port surface plus
    // for_consumers guidance (the artifact-surface contract). The resolver
    // derives its `view` capability; the assembly must derive the matching
    // provider line or the guidance never reaches the Operative.
    const fileBrowser = entry(
      "file-browser-fixture",
      "surfaces",
      "script",
      "single",
      [],
      "Workspace file browser",
      "Write run outputs and documents under the workspace root."
    );
    fileBrowser.metadata.own_port = true;
    const block = renderCapabilitiesBlock([fileBrowser]);
    expect(block).toContain("- view:file-browser-fixture");
    expect(block).toContain("Workspace file browser");
    expect(block).toContain("  Write run outputs and documents under the workspace root.");
  });

  it("does NOT derive a view provider when for_consumers is absent", () => {
    const silent = entry("silent-view", "surfaces", "script", "single", [], "Silent view fitting");
    silent.metadata.own_port = true;
    const block = renderCapabilitiesBlock([silent]);
    expect(block).toContain("no Faculties currently installed");
  });

  it("does NOT duplicate a declared provider's guidance with a derived view line", () => {
    const declared = entry(
      "monitor-fixture",
      "observability",
      "script",
      "single",
      [{ kind: "monitor", name: "vitals" }],
      "System vitals",
      "Check vitals before long runs."
    );
    declared.metadata.own_port = true;
    const block = renderCapabilitiesBlock([declared]);
    expect(block).toContain("- monitor:vitals");
    expect(block).not.toContain("- view:monitor-fixture");
    expect(block.match(/Check vitals before long runs\./g)).toHaveLength(1);
  });

  it("includes only declared providers, not consumers", () => {
    const entries = [
      entry(
        "trello",
        "memory",
        "cli",
        "multi",
        [{ kind: "connector", name: "trello" }],
        "Trello"
      ),
      entry("personal-operative", "orchestrator", "system-prompt", "single", [], "Orchestrator")
    ];
    const block = renderCapabilitiesBlock(entries);
    expect(block).toContain("connector:trello");
    expect(block).not.toContain("personal-operative");
  });
});

// The 2026-06 Quarters pivot shipped a routing prompt without the
// {{capabilities}} placeholder, silently severing provider for_consumers
// from the assembled Operative prompt. These specs pin the placeholder into
// every orchestrator prompt source the runner can resolve.
describe("substituteCapabilitiesPlaceholder", () => {
  it("inserts fitting-authored $-patterns verbatim, never as replacement directives", () => {
    // for_consumers is arbitrary fitting markdown; shell snippets full of
    // $&, $', $$ and $` must land in the prompt untouched. A string
    // replacement argument would expand them ($' splices in the rest of the
    // prompt).
    const provider = entry(
      "dollar-fitting",
      "memory",
      "script",
      "single",
      [{ kind: "memory-store", name: "dollar" }],
      "summary",
      "Use $$ for the shell pid, $& and $' in regex docs, and $`backtick`."
    );
    const prompt = "before\n{{capabilities}}\nafter";
    const result = substituteCapabilitiesPlaceholder(prompt, [provider]);
    expect(result).toContain("Use $$ for the shell pid, $& and $' in regex docs, and $`backtick`.");
    expect(result.endsWith("\nafter")).toBe(true);
    // No accidental duplication of the surrounding prompt (the $' failure mode).
    expect(result.match(/after/g)).toHaveLength(1);
  });
});

describe("orchestrator prompt sources keep the {{capabilities}} placeholder", () => {
  it("the seed garrison-orchestrator prompt declares {{capabilities}}", async () => {
    const raw = await fs.readFile(
      path.join(
        REPO_ROOT,
        "fittings",
        "seed",
        "garrison-orchestrator",
        ".apm",
        "prompts",
        "garrison-orchestrator.prompt.md"
      ),
      "utf8"
    );
    expect(raw).toContain("{{capabilities}}");
  });

  it("the composition fallback orchestrator prompts declare {{capabilities}}", async () => {
    for (const compositionId of ["default", "dogfood-orch"]) {
      const raw = await fs.readFile(
        path.join(REPO_ROOT, "compositions", compositionId, ".garrison", "prompts", "orchestrator.md"),
        "utf8"
      );
      expect(raw, `compositions/${compositionId} fallback orchestrator prompt`).toContain(
        "{{capabilities}}"
      );
    }
  });
});

describe("capabilitiesPlaceholderWarning", () => {
  it("returns the loud runner warning when the prompt lacks the placeholder", () => {
    const warning = capabilitiesPlaceholderWarning("# Orchestrator\n\nNo capabilities block here.\n");
    expect(warning).toBe(MISSING_CAPABILITIES_PLACEHOLDER_WARNING);
    expect(warning).toContain("for_consumers will NOT reach the Operative");
  });

  it("returns null when the placeholder is present", () => {
    expect(capabilitiesPlaceholderWarning("Tools:\n\n{{capabilities}}\n")).toBeNull();
  });
});

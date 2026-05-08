import { describe, expect, it } from "vitest";
import { renderCapabilitiesBlock } from "@/lib/runner";
import type { LibraryEntry, GarrisonMetadata } from "@/lib/types";

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
        "trello-data-source",
        "data-sources",
        "cli",
        "multi",
        [{ kind: "data-source", name: "trello" }],
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
    expect(block).toContain("- data-source:trello — Trello board access");
    const channelIdx = block.indexOf("channel:slack");
    const dataIdx = block.indexOf("data-source:trello");
    expect(channelIdx).toBeLessThan(dataIdx);
  });

  it("renders the for_consumers body indented under the provider line when present", () => {
    const docs = entry(
      "documents",
      "knowledge-base",
      "cli-skill",
      "single",
      [{ kind: "agent-skill", name: "project-documents" }],
      "Documents workspace",
      "Use the Documents Faculty when in PM hat.\n- bullet one\n- bullet two"
    );
    const block = renderCapabilitiesBlock([docs]);
    expect(block).toContain("- agent-skill:project-documents — Documents workspace");
    expect(block).toContain("  Use the Documents Faculty when in PM hat.");
    expect(block).toContain("  - bullet one");
    expect(block).toContain("  - bullet two");
  });

  it("falls back to the summary line when for_consumers is absent", () => {
    const trello = entry(
      "trello-data-source",
      "data-sources",
      "cli",
      "multi",
      [{ kind: "data-source", name: "trello" }],
      "Trello board access"
    );
    const block = renderCapabilitiesBlock([trello]);
    expect(block).toBe("- data-source:trello — Trello board access");
  });

  it("separates entries with a blank line when any provider ships for_consumers", () => {
    const trello = entry(
      "trello-data-source",
      "data-sources",
      "cli",
      "multi",
      [{ kind: "data-source", name: "trello" }],
      "Trello board access"
    );
    const docs = entry(
      "documents",
      "knowledge-base",
      "cli-skill",
      "single",
      [{ kind: "agent-skill", name: "project-documents" }],
      "Documents workspace",
      "Use this when capturing decisions."
    );
    const block = renderCapabilitiesBlock([trello, docs]);
    // Sorted by kind: agent-skill comes before data-source. The blank line
    // separator only kicks in once at least one provider ships for_consumers.
    expect(block).toContain(
      "  Use this when capturing decisions.\n\n- data-source:trello — Trello board access"
    );
  });

  it("includes only declared providers, not consumers", () => {
    const entries = [
      entry(
        "trello-data-source",
        "data-sources",
        "cli",
        "multi",
        [{ kind: "data-source", name: "trello" }],
        "Trello"
      ),
      entry("personal-operative", "orchestrator", "system-prompt", "single", [], "Orchestrator")
    ];
    const block = renderCapabilitiesBlock(entries);
    expect(block).toContain("data-source:trello");
    expect(block).not.toContain("personal-operative");
  });
});

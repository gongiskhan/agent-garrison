import { describe, expect, it } from "vitest";
import { renderCapabilitiesBlock } from "@/lib/runner";
import type { LibraryEntry, GarrisonMetadata } from "@/lib/types";

function entry(
  id: string,
  faculty: GarrisonMetadata["faculty"],
  shape: GarrisonMetadata["component_shape"],
  cardinalityHint: GarrisonMetadata["cardinality_hint"],
  provides: GarrisonMetadata["provides"],
  summary: string
): LibraryEntry {
  const metadata: GarrisonMetadata = {
    faculty,
    cardinality_hint: cardinalityHint,
    component_shape: shape,
    platforms: ["claude-code"],
    summary,
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

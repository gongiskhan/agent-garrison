import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { substituteCapabilitiesPlaceholder } from "@/lib/runner";
import type { GarrisonMetadata, LibraryEntry } from "@/lib/types";

const REPO_ROOT = path.resolve(__dirname, "..");
const ORCH_PROMPT = path.join(
  REPO_ROOT,
  "fittings",
  "seed",
  "personal-operative",
  ".apm",
  "prompts",
  "personal-operative.prompt.md"
);

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

describe("orchestrator prompt + {{capabilities}} substitution", () => {
  it("the seed personal-operative prompt declares the {{capabilities}} placeholder", async () => {
    const raw = await fs.readFile(ORCH_PROMPT, "utf8");
    expect(raw).toContain("{{capabilities}}");
  });

  it("substituting against a Composition with Trello selected lists channel:trello", async () => {
    const raw = await fs.readFile(ORCH_PROMPT, "utf8");
    const trello = entry(
      "trello",
      "sessions",
      "cli",
      "multi",
      [{ kind: "channel", name: "trello" }],
      "Trello board access"
    );
    const result = substituteCapabilitiesPlaceholder(raw, [trello]);
    expect(result).not.toContain("{{capabilities}}");
    expect(result).toContain("channel:trello");
    expect(result).toContain("Trello board access");
  });

  it("removing Trello from the Composition removes channel:trello from the assembled prompt", async () => {
    const raw = await fs.readFile(ORCH_PROMPT, "utf8");
    const slack = entry(
      "slack-channel",
      "channels",
      "script",
      "multi",
      [{ kind: "channel", name: "slack" }],
      "Slack inbound/outbound"
    );
    const result = substituteCapabilitiesPlaceholder(raw, [slack]);
    expect(result).not.toContain("{{capabilities}}");
    expect(result).toContain("channel:slack");
    expect(result).not.toContain("channel:trello");
  });

  it("an empty Composition renders the no-Faculties placeholder", async () => {
    const raw = await fs.readFile(ORCH_PROMPT, "utf8");
    const result = substituteCapabilitiesPlaceholder(raw, []);
    expect(result).not.toContain("{{capabilities}}");
    expect(result).toContain("no Faculties currently installed");
  });
});

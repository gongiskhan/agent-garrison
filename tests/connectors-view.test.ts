import { describe, expect, it } from "vitest";
import { buildConnectorsView, connectorIdOf } from "@/lib/connectors-view";
import type { LibraryEntry } from "@/lib/types";

// C6 — the Vault ↔ Connectors view model (pure; no secret VALUE passes through).

function entry(over: Partial<LibraryEntry> & { id: string }): LibraryEntry {
  return {
    id: over.id,
    name: over.name ?? over.id,
    faculty: "connectors" as any,
    repo: "",
    summary: over.summary ?? "",
    platforms: ["claude-code"] as any,
    ratings: {} as any,
    metadata: over.metadata as any
  } as LibraryEntry;
}

const trello = entry({
  id: "trello",
  name: "Trello",
  metadata: {
    provides: [{ kind: "connector", name: "trello" }],
    secret_scope: ["TRELLO_KEY", "TRELLO_TOKEN"],
    connector: { auth: "api_key", actions: [{ name: "create_card", mutates: true }, { name: "lists" }] }
  } as any
});

const google = entry({
  id: "google",
  name: "Google",
  metadata: {
    provides: [{ kind: "connector", name: "google" }],
    secret_scope: [],
    connector: { auth: "oauth2", actions: [{ name: "gmail.send", mutates: true }], triggers: [{ type: "listener" }] }
  } as any
});

// D26: capture-service seals three secrets (the capture token plus the two
// provider keys) but its voice connector is reached with ONLY the capture
// token - Deepgram and ElevenLabs keys never leave the service (I4), so the
// connector's sealed state must not depend on them.
const voice = entry({
  id: "capture-service",
  name: "Capture service",
  metadata: {
    provides: [{ kind: "voice", name: "capture-service" }, { kind: "connector", name: "voice" }],
    secret_scope: ["CAPTURE_TOKEN", "DEEPGRAM_API_KEY", "ELEVENLABS_API_KEY"],
    connector: {
      auth: "api_key",
      secrets: ["CAPTURE_TOKEN"],
      actions: [{ name: "transcribe" }, { name: "synthesize" }]
    }
  } as any
});

describe("buildConnectorsView (C6)", () => {
  it("api_key: sealed only when EVERY scoped secret is present", () => {
    const sealed = buildConnectorsView([trello], ["TRELLO_KEY", "TRELLO_TOKEN"], []);
    expect(sealed[0].sealed).toBe(true);
    expect(sealed[0].secrets.every((s) => s.present)).toBe(true);

    const partial = buildConnectorsView([trello], ["TRELLO_KEY"], []);
    expect(partial[0].sealed).toBe(false);
    expect(partial[0].secrets.find((s) => s.name === "TRELLO_TOKEN")?.present).toBe(false);
  });

  it("api_key with connector.secrets (D26): the view lists and seals on the subset only", () => {
    // Provider keys unsealed - irrelevant to the connector, which only needs
    // the capture token.
    const sealed = buildConnectorsView([voice], ["CAPTURE_TOKEN"], []);
    expect(sealed[0].id).toBe("voice");
    expect(sealed[0].secrets.map((s) => s.name)).toEqual(["CAPTURE_TOKEN"]);
    expect(sealed[0].sealed).toBe(true);
    // The provider keys alone seal nothing: the subset member is what counts.
    expect(buildConnectorsView([voice], ["DEEPGRAM_API_KEY", "ELEVENLABS_API_KEY"], [])[0].sealed).toBe(false);
  });

  it("api_key view never leaks values — only names + presence", () => {
    const v = buildConnectorsView([trello], ["TRELLO_KEY"], [])[0];
    expect(v.secrets.map((s) => s.name)).toEqual(["TRELLO_KEY", "TRELLO_TOKEN"]);
    expect(JSON.stringify(v)).not.toContain("value");
  });

  it("oauth2: sealed on a valid grant, not sealed when revoked/expired", () => {
    expect(buildConnectorsView([google], [], [{ connector: "google", status: "valid" }])[0].sealed).toBe(true);
    expect(buildConnectorsView([google], [], [{ connector: "google", status: "expired" }])[0].sealed).toBe(false);
    expect(buildConnectorsView([google], [], [{ connector: "google", status: "revoked" }])[0].sealed).toBe(false);
    expect(buildConnectorsView([google], [], [])[0].sealed).toBe(false); // no grant
  });

  it("reports action + mutating + trigger counts", () => {
    const v = buildConnectorsView([trello, google], [], [])[0]; // sorted -> Google first
    expect(v.name).toBe("Google");
    expect(v.mutatingActionCount).toBe(1);
    expect(v.hasTriggers).toBe(true);
  });

  it("a locked vault yields UNKNOWN status, not false 'missing' (codex C6)", () => {
    const locked = buildConnectorsView([trello, google], [], [], { vaultLocked: true });
    for (const c of locked) {
      if (c.auth !== "none") expect(c.statusKnown).toBe(false);
    }
    // status is unknown — the UI must not render these as "Not sealed".
    expect(locked.find((c) => c.id === "trello")?.statusKnown).toBe(false);
  });

  it("ignores non-connector entries", () => {
    const plain = entry({ id: "x", metadata: { provides: [{ kind: "memory-store", name: "x" }] } as any });
    expect(buildConnectorsView([plain], [], [])).toHaveLength(0);
    expect(connectorIdOf(trello)).toBe("trello");
    expect(connectorIdOf(plain)).toBeNull();
  });

  // "I go in the connections page and I don't see any way to connect": a
  // connector whose Fitting is not stationed HAS no way to connect - no
  // daemon, no reachable route - and the card must say that instead of
  // rendering dead controls.
  it("marks a connector unequipped when its Fitting is not in the composition", () => {
    const views = buildConnectorsView([trello, google], [], [], {
      equippedFittingIds: new Set(["google"])
    });
    const byId = Object.fromEntries(views.map((v) => [v.id, v]));
    expect(byId.google.equipped).toBe(true);
    expect(byId.trello.equipped).toBe(false);
    expect(byId.trello.fittingId).toBe("trello");
  });

  it("reads as equipped when the composition could not be read - never falsely 'not stationed'", () => {
    const views = buildConnectorsView([trello], [], []);
    expect(views[0].equipped).toBe(true);
  });
});
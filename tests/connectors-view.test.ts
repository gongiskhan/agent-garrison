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

describe("buildConnectorsView (C6)", () => {
  it("api_key: sealed only when EVERY scoped secret is present", () => {
    const sealed = buildConnectorsView([trello], ["TRELLO_KEY", "TRELLO_TOKEN"], []);
    expect(sealed[0].sealed).toBe(true);
    expect(sealed[0].secrets.every((s) => s.present)).toBe(true);

    const partial = buildConnectorsView([trello], ["TRELLO_KEY"], []);
    expect(partial[0].sealed).toBe(false);
    expect(partial[0].secrets.find((s) => s.name === "TRELLO_TOKEN")?.present).toBe(false);
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
});

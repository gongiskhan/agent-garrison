// scripts/remote-shell/csg-local.yml.example - csg's actual local.yml, kept
// as a checked-in example (local.yml itself is gitignored, machine-local).
// What matters is that it is not just a plausible-looking document: it must
// be valid YAML, parse into the exact shape applyLocalOverlay expects, and,
// applied against the REAL compositions/default/apm.yml, unstation exactly
// the intended 19 fitting ids (no more, no less), leave everything else
// untouched, and correctly blank remote-shell-runtime's own transports so
// csg never dials its own tunnel back to itself. Reading the real on-disk
// apm.yml (not a fixture) means this test also catches future drift - a
// renamed or removed fitting id in the composition breaks this test instead
// of silently no-op'ing in production the way an unmatched unstation id
// otherwise would.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { applyLocalOverlay, manifestToComposition, type LocalOverlay } from "@/lib/compositions";

const EXAMPLE_PATH = path.resolve(__dirname, "..", "scripts", "remote-shell", "csg-local.yml.example");
const REAL_MANIFEST_PATH = path.resolve(__dirname, "..", "compositions", "default", "apm.yml");

const EXPECTED_UNSTATION = [
  "codex-runtime",
  "gemini-runtime",
  "opencode-runtime",
  "browser-default",
  "screen-share-default",
  "snapshots-default",
  "basic-memory",
  "vault-git-sync",
  "improver",
  "improver-nightly",
  "slack-channel",
  "email-channel",
  "omi-channel",
  "whatsapp-web",
  "capture-service",
  "trello",
  "google",
  "cortex-automations",
  "cortex-client",
  "loop-heartbeat"
];

function loadOverlay(): LocalOverlay {
  const raw = yaml.load(readFileSync(EXAMPLE_PATH, "utf8")) as Record<string, unknown>;
  // Same extraction readLocalOverlay() does for a non-nested document.
  return {
    unstation: Array.isArray(raw.unstation) ? (raw.unstation as string[]) : undefined,
    selections: raw.selections as LocalOverlay["selections"]
  };
}

describe("csg-local.yml.example", () => {
  it("is valid YAML with the exact top-level shape applyLocalOverlay expects", () => {
    const overlay = loadOverlay();
    expect(overlay.unstation).toBeDefined();
    expect(overlay.selections).toBeDefined();
    expect(Array.isArray(overlay.unstation)).toBe(true);
  });

  it("names exactly the 19 fitting ids the plan specifies - no more, no less", () => {
    const overlay = loadOverlay();
    expect(overlay.unstation).toEqual(EXPECTED_UNSTATION);
  });

  it("never names a refused id (orchestrator/http-gateway/scheduler)", () => {
    const overlay = loadOverlay();
    for (const refused of ["orchestrator", "http-gateway", "scheduler"]) {
      expect(overlay.unstation).not.toContain(refused);
    }
  });

  it("blanks remote-shell-runtime's transports so csg never dials its own tunnel", () => {
    const overlay = loadOverlay();
    const rsh = overlay.selections?.runtimes?.find((s) => s.id === "remote-shell-runtime");
    expect(rsh?.config.transports).toBe("{}");
  });

  it("applied against the REAL compositions/default/apm.yml, unstations exactly every intended id and only those - every named fitting genuinely exists there today", () => {
    const manifest = yaml.load(readFileSync(REAL_MANIFEST_PATH, "utf8")) as Parameters<typeof applyLocalOverlay>[0];
    const overlay = loadOverlay();
    const before = manifestToComposition("default", manifest);
    const after = manifestToComposition("default", applyLocalOverlay(manifest, overlay));

    const idsOf = (comp: typeof before) => new Set(Object.values(comp.selections).flat().map((s) => s?.id));
    const beforeIds = idsOf(before);
    const afterIds = idsOf(after);

    // Every unstationed id was actually present before (a stale/typo'd id in
    // the example would otherwise pass silently as a no-op).
    for (const id of EXPECTED_UNSTATION) {
      expect(beforeIds.has(id), `"${id}" is named in csg-local.yml.example but is not stationed in compositions/default/apm.yml today`).toBe(true);
    }
    // And every one of them is gone afterward, with nothing else removed.
    const actuallyRemoved = [...beforeIds].filter((id) => !afterIds.has(id));
    expect(new Set(actuallyRemoved)).toEqual(new Set(EXPECTED_UNSTATION));

    // remote-shell-runtime itself is NOT unstationed (csg still needs its
    // `local` transport for its own Sessions rows) - only reconfigured.
    expect(afterIds.has("remote-shell-runtime")).toBe(true);
    const rsh = after.selections.runtimes?.find((s) => s.id === "remote-shell-runtime");
    expect(rsh?.config.transports).toBe("{}");
  });
});

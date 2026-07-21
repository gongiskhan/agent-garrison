import { describe, it, expect } from "vitest";
import { migrateSelectionsByFaculty } from "@/lib/compositions";
import type { FittingSelectionMap, LibraryEntry } from "@/lib/types";

// Minimal LibraryEntry stand-in — migrateSelectionsByFaculty only reads .id and
// .faculty, so the rest is irrelevant to this gate.
function entry(id: string, faculty: string): LibraryEntry {
  return { id, faculty } as unknown as LibraryEntry;
}

const entries = [
  entry("dev-env", "sessions"),
  entry("file-browser", "sessions"),
  entry("codex-runtime", "runtimes"),
  entry("gemini-runtime", "runtimes"),
  entry("browser-default", "surfaces"),
  entry("screen-share-default", "surfaces")
];

describe("composition faculty migration (2026-06-18 sessions split)", () => {
  it("re-buckets moved fittings to their current faculty, preserving config", () => {
    const stored: FittingSelectionMap = {
      sessions: [
        { id: "dev-env", config: { port: 27086 } },
        { id: "file-browser", config: {} },
        { id: "codex-runtime", config: {} },
        { id: "gemini-runtime", config: {} },
        { id: "browser-default", config: { port: 27084 } },
        { id: "screen-share-default", config: {} }
      ]
    };
    const out = migrateSelectionsByFaculty(stored, entries);
    expect(out.sessions?.map((s) => s.id).sort()).toEqual(["dev-env", "file-browser"]);
    expect(out.runtimes?.map((s) => s.id).sort()).toEqual(["codex-runtime", "gemini-runtime"]);
    expect(out.surfaces?.map((s) => s.id).sort()).toEqual(["browser-default", "screen-share-default"]);
    // config preserved across the move
    expect(out.surfaces?.find((s) => s.id === "browser-default")?.config).toEqual({ port: 27084 });
  });

  it("returns the same object reference when nothing moved (already correct)", () => {
    const correct: FittingSelectionMap = {
      sessions: [{ id: "dev-env", config: {} }],
      runtimes: [{ id: "codex-runtime", config: {} }]
    };
    expect(migrateSelectionsByFaculty(correct, entries)).toBe(correct);
  });

  it("keeps unknown fitting ids under their stored key (so validation surfaces them)", () => {
    const stored: FittingSelectionMap = { sessions: [{ id: "ghost-fitting", config: {} }] };
    const out = migrateSelectionsByFaculty(stored, entries);
    expect(out.sessions?.map((s) => s.id)).toEqual(["ghost-fitting"]);
  });
});

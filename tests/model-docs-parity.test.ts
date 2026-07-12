import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FACULTY_ALIASES, parseGarrisonMetadata } from "@/lib/metadata";
import { capabilityKinds, facultyIds } from "@/lib/types";
import { readYamlFile } from "@/lib/yaml";

// The model-vs-docs coherence contract: the faculty and capability vocabularies
// in src/lib/types.ts are the source of truth, and the docs plus the curated
// registry must track them. Guards against the drift class fixed on 2026-07-01
// (live kinds filed under "historical", stale faculty counts, registry entries
// whose manifests no longer parse). See DECISIONS.md 2026-07-01.

const ROOT = path.resolve(__dirname, "..");
const SEED_DIR = path.join(ROOT, "fittings", "seed");

interface RawManifest {
  "x-garrison"?: unknown;
}

interface LibraryEntryRaw {
  id: string;
  summary?: string;
  localPath?: string;
}

function readDoc(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

function readLibrary(): LibraryEntryRaw[] {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "library.json"), "utf8"));
  return Array.isArray(raw) ? raw : (raw.entries ?? raw.fittings ?? []);
}

describe("model/docs parity", () => {
  it("every faculty id is documented in docs/FACULTIES.md", () => {
    const doc = readDoc("docs/FACULTIES.md");
    for (const id of facultyIds) {
      expect(doc, `faculty "${id}" missing from docs/FACULTIES.md`).toContain(`**${id}**`);
    }
  });

  it("every capability kind has its own section in docs/CAPABILITIES.md", () => {
    const doc = readDoc("docs/CAPABILITIES.md");
    for (const kind of capabilityKinds) {
      expect(doc, `kind "${kind}" has no "## ${kind}" section in docs/CAPABILITIES.md`).toMatch(
        new RegExp(`^## ${kind}$`, "m")
      );
    }
  });

  it("docs/CAPABILITIES.md does not list dropped kinds as current", () => {
    const doc = readDoc("docs/CAPABILITIES.md");
    const currentList = doc.slice(0, doc.indexOf("## Dropped kinds (historical)"));
    const enforcedListBlock = currentList.slice(0, currentList.indexOf("Dropped kinds, kept below"));
    for (const dropped of ["data-source", "artifact-store", "soul", "agent-skill"]) {
      expect(
        enforcedListBlock,
        `dropped kind "${dropped}" appears in the current-kinds intro of docs/CAPABILITIES.md`
      ).not.toContain(`\`${dropped}\``);
    }
  });

  it("every faculty alias targets a live faculty id and no alias shadows one", () => {
    for (const [alias, target] of Object.entries(FACULTY_ALIASES)) {
      expect(facultyIds, `alias "${alias}" targets unknown faculty "${target}"`).toContain(target);
      expect(
        facultyIds as readonly string[],
        `alias "${alias}" shadows a live faculty id`
      ).not.toContain(alias);
    }
  });

  it("no doc claims an alias rewrite onto a parked (rejected) faculty id", () => {
    // Regression guard for the 2026-07-01 Codex finding: CLAUDE.md claimed
    // `faculty: testing-framework` rewrites to `faculty: skills`, but parked ids
    // (skills/classifier/soul/knowledge-base) are rejected, never alias targets.
    const parkedClaim = /(?:->|→|rewritten to|folds? into)[\s\S]{0,40}`?faculty: (?:skills|classifier|soul|knowledge-base)`?/;
    for (const doc of ["CLAUDE.md", "docs/METADATA.md", "docs/FACULTIES.md"]) {
      expect(readDoc(doc), `${doc} claims an alias onto a parked faculty id`).not.toMatch(
        parkedClaim
      );
    }
  });

  it("LICENSE exists and matches the package.json license field", () => {
    const licence = fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8");
    expect(licence).toContain("MIT License");
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    expect(pkg.license).toBe("MIT");
  });

  it("every library-registered Fitting parses with a non-empty summary", async () => {
    const entries = readLibrary();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      // A Fitting's manifest lives at its localPath (seed Fittings under
      // fittings/seed/<id>, clones under fittings/local/<id>); fall back to the
      // seed-dir convention when no localPath is recorded.
      const fittingDir = entry.localPath ? path.join(ROOT, entry.localPath) : path.join(SEED_DIR, entry.id);
      const manifestPath = path.join(fittingDir, "apm.yml");
      expect(fs.existsSync(manifestPath), `library entry "${entry.id}" has no apm.yml`).toBe(
        true
      );
      const manifest = await readYamlFile<RawManifest>(manifestPath);
      expect(manifest, `seed ${entry.id} apm.yml unreadable`).toBeTruthy();
      const metadata = parseGarrisonMetadata(manifest!["x-garrison"]);
      expect(
        (metadata.summary ?? "").trim().length,
        `library entry "${entry.id}" has an empty x-garrison.summary`
      ).toBeGreaterThan(0);
      expect(facultyIds).toContain(metadata.faculty);
    }
  });
});

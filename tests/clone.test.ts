import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { CloneError, cloneDrift, cloneFitting, readCloneProvenance } from "@/lib/clone";
import { FittingFileError, createFile } from "@/lib/fitting-files";
import { getLibraryEntry, readRawLibrary } from "@/lib/library";
import { readYamlFile } from "@/lib/yaml";
import { ROOT_DIR } from "@/lib/paths";

// clone.test.ts owns the ONLY test writes to data/library.json. It snapshots the
// registry once, and after each test restores that snapshot and deletes any
// temp clone dirs it created — so a failed assertion, or a parallel test file
// reading the registry, never sees a leftover clone. writeRawLibrary is atomic,
// so a concurrent reader never catches a torn file mid-write either.

const LOCAL_DIR = path.join(ROOT_DIR, "fittings", "local");
const LIBRARY_PATH = path.join(ROOT_DIR, "data", "library.json");
const SOURCE_ID = "taste"; // small, stable seed skill Fitting

let librarySnapshot: string;
const createdIds: string[] = [];

// Clone into an explicit temp id and remember it for cleanup.
async function cloneTemp(sourceId: string, newId: string) {
  createdIds.push(newId);
  return cloneFitting(sourceId, { newId });
}

beforeAll(async () => {
  librarySnapshot = await fs.readFile(LIBRARY_PATH, "utf8");
});

afterEach(async () => {
  await fs.writeFile(LIBRARY_PATH, librarySnapshot, "utf8");
  while (createdIds.length) {
    const id = createdIds.pop()!;
    await fs.rm(path.join(LOCAL_DIR, id), { recursive: true, force: true }).catch(() => {});
  }
});

describe("cloneFitting", () => {
  it("copies the source tree, writes provenance, and appends a resolvable library entry", async () => {
    const entry = await cloneTemp(SOURCE_ID, "s3ct-copy");

    // The returned entry is a first-class, resolved LibraryEntry.
    expect(entry.id).toBe("s3ct-copy");
    expect(entry.localPath).toBe("fittings/local/s3ct-copy");
    expect(entry.repo).toBe("local:fittings/local/s3ct-copy");
    expect(entry.cloned_from).toBe("taste@0.1.0");
    // Metadata is derived from the copied apm.yml, so the clone lands in the
    // same Faculty as its source and is selectable exactly like any Fitting.
    expect(entry.faculty).toBe("design");
    expect(entry.metadata.component_shape).toBe("skill");

    // Authored content came across, including the `.apm/` skill files.
    const cloneRoot = path.join(LOCAL_DIR, "s3ct-copy");
    for (const rel of [
      "apm.yml",
      "LICENSE",
      ".apm/skills/design-taste-frontend/SKILL.md",
      ".apm/skills/redesign-existing-projects/SKILL.md"
    ]) {
      await expect(fs.access(path.join(cloneRoot, rel))).resolves.toBeUndefined();
    }

    // The manifest is re-keyed to the new id and its _local/ verify path is
    // repointed, so it installs/verifies as its own APM package.
    const manifest = await readYamlFile<{ name?: string; "x-garrison"?: { verify?: { command?: string } } }>(
      path.join(cloneRoot, "apm.yml")
    );
    expect(manifest?.name).toBe("s3ct-copy");
    expect(manifest?.["x-garrison"]?.verify?.command).toContain("_local/s3ct-copy/");
    expect(manifest?.["x-garrison"]?.verify?.command).not.toContain("_local/taste/");

    // Provenance file records the pin + a non-empty per-file baseline.
    const prov = await readCloneProvenance("s3ct-copy");
    expect(prov?.cloned_from).toBe("taste@0.1.0");
    expect(typeof prov?.clonedAt).toBe("string");
    expect(Object.keys(prov?.files ?? {}).length).toBeGreaterThan(0);
    // clone.json is provenance, never part of the drift baseline.
    expect(prov?.files["clone.json"]).toBeUndefined();

    // Registry entry is well-formed and resolveLibraryEntry loads it.
    const raw = (await readRawLibrary()).find((e) => e.id === "s3ct-copy");
    expect(raw).toMatchObject({
      id: "s3ct-copy",
      repo: "local:fittings/local/s3ct-copy",
      localPath: "fittings/local/s3ct-copy",
      cloned_from: "taste@0.1.0"
    });
    const resolved = await getLibraryEntry("s3ct-copy");
    expect(resolved?.id).toBe("s3ct-copy");
    expect(resolved?.faculty).toBe("design");
  });

  it("defaults the new id to <source>-copy and refuses a duplicate id", async () => {
    const entry = await cloneFitting(SOURCE_ID); // no explicit id
    createdIds.push(entry.id);
    expect(entry.id).toBe("taste-copy");

    await expect(cloneFitting(SOURCE_ID, { newId: "taste-copy" })).rejects.toBeInstanceOf(CloneError);
  });

  it("rejects an unknown source", async () => {
    await expect(cloneFitting("does-not-exist")).rejects.toBeInstanceOf(CloneError);
  });
});

describe("cloneDrift", () => {
  it("is clean for an untouched clone and drifts on a local edit", async () => {
    await cloneTemp(SOURCE_ID, "s3ct-drift");

    const before = await cloneDrift("s3ct-drift");
    expect(before.drifted).toEqual([]);
    expect(before.clean).toContain("apm.yml");
    expect(before.clean.length).toBeGreaterThan(0);

    // Edit an existing baseline file directly on disk.
    const licensePath = path.join(LOCAL_DIR, "s3ct-drift", "LICENSE");
    await fs.appendFile(licensePath, "\n// local change\n", "utf8");

    const after = await cloneDrift("s3ct-drift");
    expect(after.drifted).toContain("LICENSE");
    expect(after.clean).not.toContain("LICENSE");
  });

  it("404s (throws CloneError) for a Fitting that is not a clone", async () => {
    await expect(cloneDrift(SOURCE_ID)).rejects.toBeInstanceOf(CloneError);
    expect(await readCloneProvenance(SOURCE_ID)).toBeNull();
  });
});

describe("createFile", () => {
  it("creates a new file (mkdir -p parent) and it reads back as drift", async () => {
    await cloneTemp(SOURCE_ID, "s3ct-create");

    const result = await createFile("s3ct-create", "notes/hello.md", "hi");
    expect(result.path).toBe("notes/hello.md");
    expect(result.size).toBe(2);

    const onDisk = await fs.readFile(path.join(LOCAL_DIR, "s3ct-create", "notes/hello.md"), "utf8");
    expect(onDisk).toBe("hi");

    // A brand-new file is not in the baseline, so clone-status flags it.
    const drift = await cloneDrift("s3ct-create");
    expect(drift.drifted).toContain("notes/hello.md");
  });

  it("refuses to overwrite an existing file", async () => {
    await cloneTemp(SOURCE_ID, "s3ct-exists");
    await createFile("s3ct-exists", "notes/x.md", "one");
    await expect(createFile("s3ct-exists", "notes/x.md", "two")).rejects.toMatchObject({
      status: 409
    });
    // The overwrite endpoint's contract is unchanged: the original content stays.
    const onDisk = await fs.readFile(path.join(LOCAL_DIR, "s3ct-exists", "notes/x.md"), "utf8");
    expect(onDisk).toBe("one");
  });

  it("rejects a path that escapes the fitting directory", async () => {
    await cloneTemp(SOURCE_ID, "s3ct-escape");
    await expect(createFile("s3ct-escape", "../escape.md", "x")).rejects.toMatchObject({
      status: 400
    });
    await expect(fs.access(path.join(LOCAL_DIR, "escape.md"))).rejects.toBeTruthy();
  });

  it("rejects a blocked path segment", async () => {
    await cloneTemp(SOURCE_ID, "s3ct-blocked");
    await expect(createFile("s3ct-blocked", ".git/config", "x")).rejects.toMatchObject({
      status: 400
    });
    await expect(createFile("s3ct-blocked", ".apm/skills/evil/SKILL.md", "x")).rejects.toBeInstanceOf(
      FittingFileError
    );
  });
});

describe("copy independence", () => {
  it("an edit to the upstream source never changes the clone", async () => {
    // A mutable source: clone taste once to get a fixture we can freely edit
    // without touching the hash-pinned seed.
    const source = await cloneTemp(SOURCE_ID, "s3ct-src");
    const clone = await cloneTemp(source.id, "s3ct-fromsrc");

    const cloneLicense = path.join(LOCAL_DIR, clone.id, "LICENSE");
    const original = await fs.readFile(cloneLicense, "utf8");

    // Mutate the upstream fixture AFTER the clone was made.
    await fs.writeFile(path.join(LOCAL_DIR, source.id, "LICENSE"), "UPSTREAM MOVED ON", "utf8");

    // The clone is a byte copy on its own inode — unaffected.
    expect(await fs.readFile(cloneLicense, "utf8")).toBe(original);
    const drift = await cloneDrift(clone.id);
    expect(drift.drifted).not.toContain("LICENSE");
  });
});

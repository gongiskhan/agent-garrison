// G5: the quarters_descriptor.file_sets schema - the manifest-authoring half
// of the restricted-glob contract (the runtime-matching half lives in
// quarters-runtimes.ts / tests/quarters-runtimes.test.ts). Both must agree on
// what counts as a valid glob string, which is why this file and that one
// assert on the identical fixture set below.

import { describe, expect, it } from "vitest";
import { isRestrictedQuartersGlob, parseGarrisonMetadata } from "@/lib/metadata";

const baseMetadata = {
  faculty: "runtimes" as const,
  cardinality_hint: "multi" as const,
  component_shape: "cli-skill" as const,
  platforms: ["claude-code"],
  verify: { command: "echo ok", expect: "ok" }
};

const baseDescriptor = {
  tier: "generic" as const,
  id: "cursor",
  home_dir: "~/.cursor"
};

const rulesFileSet = {
  id: "rules",
  label: "Rules",
  root: "~/.cursor/rules",
  glob: "*.mdc",
  format: "markdown" as const,
  frontmatter: ["description", "globs", "alwaysApply"],
  create: true
};

describe("quarters_descriptor.file_sets glob grammar", () => {
  it.each([
    ["*.mdc", true],
    ["hooks.json", true],
    ["SKILL.md", true],
    ["*/SKILL.md", true],
    ["{settings,keybindings}.json", true],
    ["{a,b,c}.mdc", true],
    ["../escape.mdc", false],
    ["/etc/passwd", false],
    ["a/b/c.mdc", false], // depth > 2
    ["", false],
    ["skills//SKILL.md", false], // an empty segment between two slashes
    ["*/*.mdc", true], // a dir wildcard AND a file-ext wildcard is still depth 2
    ["{onlyone}.json", false] // a brace list needs at least two alternatives
  ])("%s -> %s", (glob, expected) => {
    expect(isRestrictedQuartersGlob(glob)).toBe(expected);
  });
});

describe("quarters_descriptor.file_sets schema", () => {
  it("accepts a well-formed markdown file_sets entry with frontmatter + create", () => {
    const metadata = parseGarrisonMetadata({
      ...baseMetadata,
      quarters_descriptor: { ...baseDescriptor, file_sets: [rulesFileSet] }
    });
    expect(metadata.quarters_descriptor?.file_sets).toHaveLength(1);
    expect(metadata.quarters_descriptor?.file_sets?.[0]).toMatchObject({ id: "rules", format: "markdown" });
  });

  it("accepts a json file_sets entry with write: merge", () => {
    const metadata = parseGarrisonMetadata({
      ...baseMetadata,
      quarters_descriptor: {
        ...baseDescriptor,
        file_sets: [{ id: "hooks", label: "Hooks", root: "~/.cursor", glob: "hooks.json", format: "json", write: "merge" }]
      }
    });
    expect(metadata.quarters_descriptor?.file_sets?.[0]).toMatchObject({ write: "merge" });
  });

  it("rejects frontmatter on a json file_sets entry", () => {
    expect(() =>
      parseGarrisonMetadata({
        ...baseMetadata,
        quarters_descriptor: {
          ...baseDescriptor,
          file_sets: [{ id: "hooks", label: "Hooks", root: "~/.cursor", glob: "hooks.json", format: "json", frontmatter: ["x"] }]
        }
      })
    ).toThrow(/frontmatter is only valid when format is markdown/);
  });

  it("rejects write: merge on a markdown file_sets entry", () => {
    expect(() =>
      parseGarrisonMetadata({
        ...baseMetadata,
        quarters_descriptor: { ...baseDescriptor, file_sets: [{ ...rulesFileSet, write: "merge" }] }
      })
    ).toThrow(/write:'merge' is only valid when format is json/);
  });

  it("rejects a glob outside the restricted grammar", () => {
    expect(() =>
      parseGarrisonMetadata({
        ...baseMetadata,
        quarters_descriptor: { ...baseDescriptor, file_sets: [{ ...rulesFileSet, glob: "../escape.mdc" }] }
      })
    ).toThrow(/file_sets glob must be a restricted pattern/);
  });

  it("rejects duplicate file_sets ids within one descriptor", () => {
    expect(() =>
      parseGarrisonMetadata({
        ...baseMetadata,
        quarters_descriptor: { ...baseDescriptor, file_sets: [rulesFileSet, { ...rulesFileSet, root: "~/.cursor/skills" }] }
      })
    ).toThrow(/file_sets ids must be unique/);
  });

  it("rejects an unknown key on a file_sets entry (strict)", () => {
    expect(() =>
      parseGarrisonMetadata({
        ...baseMetadata,
        quarters_descriptor: { ...baseDescriptor, file_sets: [{ ...rulesFileSet, extra: "nope" }] }
      })
    ).toThrow();
  });

  it("accepts platform and scope on a file_sets entry", () => {
    const metadata = parseGarrisonMetadata({
      ...baseMetadata,
      quarters_descriptor: {
        ...baseDescriptor,
        file_sets: [
          { id: "desktop", label: "Desktop", root: "~/Library/Application Support/Cursor/User", glob: "{settings,keybindings}.json", format: "json", platform: "darwin" },
          { id: "project-rules", label: "Project rules", root: ".cursor/rules", glob: "*.mdc", format: "markdown", scope: "project", create: true }
        ]
      }
    });
    expect(metadata.quarters_descriptor?.file_sets?.map((f) => f.id)).toEqual(["desktop", "project-rules"]);
  });

  it("stays optional - a descriptor with no file_sets still parses", () => {
    const metadata = parseGarrisonMetadata({ ...baseMetadata, quarters_descriptor: baseDescriptor });
    expect(metadata.quarters_descriptor?.file_sets).toBeUndefined();
  });
});

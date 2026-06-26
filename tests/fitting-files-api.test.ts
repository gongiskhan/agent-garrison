import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FittingFileError,
  listDirectory,
  readFile,
  writeFile
} from "@/lib/fitting-files";
import { ROOT_DIR } from "@/lib/paths";

const TEST_FITTING_ID = "basic-memory";
const TEMP_FILENAME = ".garrison-test-write.tmp";
const TEMP_RELATIVE = TEMP_FILENAME;
const TEMP_ABSOLUTE = path.resolve(ROOT_DIR, "fittings/seed/basic-memory", TEMP_FILENAME);

describe("fitting files api", () => {
  beforeAll(async () => {
    await fs.writeFile(TEMP_ABSOLUTE, "initial\n", "utf8");
  });

  afterAll(async () => {
    try {
      await fs.unlink(TEMP_ABSOLUTE);
    } catch {
      // already removed
    }
  });

  it("lists the root of a local fitting and sorts dirs first", async () => {
    const listing = await listDirectory("browser-default", "");
    expect(listing.path).toBe("");
    const names = listing.entries.map((entry) => entry.name);
    expect(names).toContain("apm.yml");
    const dirIndex = listing.entries.findIndex((entry) => entry.type === "dir");
    const fileIndex = listing.entries.findIndex((entry) => entry.type === "file");
    if (dirIndex !== -1 && fileIndex !== -1) {
      expect(dirIndex).toBeLessThan(fileIndex);
    }
  });

  it("rejects path traversal in directory listing", async () => {
    await expect(listDirectory("browser-default", "../etc")).rejects.toBeInstanceOf(FittingFileError);
    await expect(listDirectory("browser-default", "../../../etc")).rejects.toMatchObject({ status: 400 });
  });

  it("hides node_modules / .git / .DS_Store", async () => {
    const listing = await listDirectory(TEST_FITTING_ID, "");
    const names = listing.entries.map((entry) => entry.name);
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain(".git");
    expect(names).not.toContain(".DS_Store");
  });

  it("reads an existing file", async () => {
    const file = await readFile(TEST_FITTING_ID, "apm.yml");
    expect(file.encoding).toBe("utf8");
    expect(file.content.length).toBeGreaterThan(0);
    expect(file.content).toMatch(/memory/i);
  });

  it("returns 404 for a missing file", async () => {
    await expect(readFile(TEST_FITTING_ID, "definitely-not-a-real-file.md")).rejects.toMatchObject({
      status: 404
    });
  });

  it("rejects an unknown fitting id", async () => {
    await expect(readFile("not-a-real-fitting", "anything")).rejects.toMatchObject({ status: 404 });
  });

  it("write + read roundtrip on an existing file", async () => {
    const next = `roundtrip-${Date.now()}\n`;
    const result = await writeFile(TEST_FITTING_ID, TEMP_RELATIVE, next);
    expect(result.size).toBe(Buffer.byteLength(next, "utf8"));
    const after = await readFile(TEST_FITTING_ID, TEMP_RELATIVE);
    expect(after.content).toBe(next);
  });

  it("refuses to create new files via write", async () => {
    await expect(
      writeFile(TEST_FITTING_ID, ".does-not-exist.tmp", "no")
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects writes that escape the fitting directory", async () => {
    await expect(writeFile(TEST_FITTING_ID, "../escape.txt", "no")).rejects.toMatchObject({
      status: 400
    });
  });

  it("rejects writes whose path includes a blocked segment", async () => {
    await expect(writeFile(TEST_FITTING_ID, ".git/config", "no")).rejects.toMatchObject({
      status: 400
    });
    await expect(
      writeFile(TEST_FITTING_ID, "node_modules/something/index.js", "no")
    ).rejects.toMatchObject({ status: 400 });
  });
});

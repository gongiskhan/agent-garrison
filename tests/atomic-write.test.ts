import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileAtomic, writeJsonAtomic, readFileTolerant } from "@/lib/atomic-write";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gar-atomic-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  it("writes the file and creates missing parent directories", async () => {
    const target = path.join(dir, "a", "b", "c.txt");
    await writeFileAtomic(target, "hello");
    expect(fs.readFileSync(target, "utf8")).toBe("hello");
  });

  it("leaves no temp-file residue", async () => {
    const target = path.join(dir, "out.txt");
    await writeFileAtomic(target, "x");
    const stray = fs.readdirSync(dir).filter((e) => e.includes("garrison-tmp"));
    expect(stray).toEqual([]);
  });

  it("never yields a torn file under concurrent writers + readers", async () => {
    const target = path.join(dir, "hot.txt");
    // Distinct, full-content payloads of varying length.
    const payloads = Array.from({ length: 24 }, (_, i) => `payload-${i}-` + "Z".repeat(500 + i * 7));
    await writeFileAtomic(target, payloads[0]); // ensure it exists before readers start

    let tornObserved = false;
    const readers = Array.from({ length: 200 }, async () => {
      try {
        const t = fs.readFileSync(target, "utf8");
        if (t.length > 0 && !payloads.includes(t)) tornObserved = true;
      } catch {
        /* a transient ENOENT during rename is fine; truncation is not */
      }
    });
    const writers = payloads.map((p) => writeFileAtomic(target, p));
    await Promise.all([...writers, ...readers]);

    expect(tornObserved).toBe(false);
    // Final content must be exactly one complete payload.
    expect(payloads).toContain(fs.readFileSync(target, "utf8"));
  });

  it("writes THROUGH a symlinked directory into the real target, link intact", async () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), "gar-real-"));
    const link = path.join(dir, "linked");
    fs.symlinkSync(real, link, "dir");
    try {
      const target = path.join(link, "deployed.txt");
      await writeFileAtomic(target, "through");
      // The real backing dir got the file...
      expect(fs.readFileSync(path.join(real, "deployed.txt"), "utf8")).toBe("through");
      // ...and the symlink is still a symlink (not clobbered into a real dir).
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    } finally {
      fs.rmSync(real, { recursive: true, force: true });
    }
  });

  it("writeJsonAtomic pretty-prints with a trailing newline", async () => {
    const target = path.join(dir, "s.json");
    await writeJsonAtomic(target, { b: 2, a: 1 });
    const raw = fs.readFileSync(target, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw)).toEqual({ b: 2, a: 1 });
    expect(raw).toContain("\n  "); // indented
  });
});

describe("readFileTolerant", () => {
  it("returns exists:false for a missing file", async () => {
    const r = await readFileTolerant(path.join(dir, "nope.txt"));
    expect(r).toEqual({ exists: false, text: "" });
  });

  it("returns the content of an existing file", async () => {
    const target = path.join(dir, "present.txt");
    fs.writeFileSync(target, "value");
    const r = await readFileTolerant(target);
    expect(r).toEqual({ exists: true, text: "value" });
  });

  it("retries a failing validator and returns the raw read once retries exhaust", async () => {
    const target = path.join(dir, "j.json");
    fs.writeFileSync(target, "{not json"); // never parses
    let attempts = 0;
    const r = await readFileTolerant(target, {
      retries: 2,
      delayMs: 1,
      validate: (t) => {
        attempts += 1;
        JSON.parse(t); // throws -> retry
      }
    });
    expect(attempts).toBe(3); // initial + 2 retries
    expect(r).toEqual({ exists: true, text: "{not json" });
  });
});

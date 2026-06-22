import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — pure .mjs
import { snapshotSkill, restoreSkill, shaOf, skillMdPath } from "../fittings/seed/improver/lib/snapshot.mjs";

describe("snapshot + byte-identical rollback (MR5c — snapshot-rollback)", () => {
  it("snapshots before apply and restores the original byte-for-byte", async () => {
    const root = mkdtempSync(join(tmpdir(), "improver-snap-"));
    try {
      const claudeHome = join(root, "claude");
      const dataDir = join(root, "data");
      const live = skillMdPath(claudeHome, "foo");
      mkdirSync(join(claudeHome, "skills", "foo"), { recursive: true });
      const original = "---\nname: foo\ndescription: d\n---\n\nbody\n";
      writeFileSync(live, original, "utf8");

      const snap = await snapshotSkill("foo", "id-1", { claudeHome, dataDir });
      expect(snap.sha).toBe(shaOf(original));
      expect(existsSync(snap.path)).toBe(true);

      // simulate an apply mutating the live file
      writeFileSync(live, original + "\nAPPENDED\n", "utf8");
      expect(readFileSync(live, "utf8")).not.toBe(original);

      const r = await restoreSkill("foo", "id-1", { claudeHome, dataDir });
      expect(r.restored).toBe(true);
      expect(r.matches).toBe(true); // byte-identical to the snapshot sha
      expect(r.sha).toBe(snap.sha);
      expect(readFileSync(live, "utf8")).toBe(original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restoring a missing snapshot reports it without throwing", async () => {
    const root = mkdtempSync(join(tmpdir(), "improver-snap-"));
    try {
      const r = await restoreSkill("nope", "id-x", { claudeHome: join(root, "claude"), dataDir: join(root, "data") });
      expect(r.restored).toBe(false);
      expect(r.reason).toBe("snapshot-missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

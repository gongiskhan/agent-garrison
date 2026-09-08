import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
// @ts-ignore — pure .mjs server
import { resolveBriefPath } from "../packages/talk/src/server.mjs";

// Confinement contract for the brief editor's direct file access: only "*.md" files
// under ~/**/briefs/ are reachable. The realpath-of-ancestor check needs the ancestor
// to actually exist, so we anchor tests on the user's real home dir.
const HOME = os.homedir();
const briefsDir = path.join(HOME, ".garrison", "automations", "briefs");

describe("web-channel: resolveBriefPath (brief file confinement)", () => {
  it("accepts a .md brief under ~/**/briefs/ (absolute and ~-expanded)", () => {
    const abs = path.join(briefsDir, "weekly-report.md");
    expect(resolveBriefPath(abs)).toBe(abs);
    expect(resolveBriefPath("~/.garrison/automations/briefs/weekly-report.md")).toBe(abs);
  });

  it("accepts a brief whose file does not exist yet (create-on-save), dir realpaths under home", () => {
    const abs = path.join(briefsDir, "brand-new-does-not-exist.md");
    expect(resolveBriefPath(abs)).toBe(abs);
  });

  it("accepts the CARD-OWNED kanban brief under ~/.garrison/ (not in a 'briefs' dir)", () => {
    // Confinement requires the store to live UNDER the user's home, so this
    // case names a home-relative store explicitly rather than using the
    // suite's temp GARRISON_HOME (pinned outside $HOME so that no test can
    // reach the real ~/.garrison).
    const prev = process.env.GARRISON_HOME;
    process.env.GARRISON_HOME = path.join(HOME, ".garrison-brief-test");
    try {
      const abs = path.join(
        process.env.GARRISON_HOME,
        "kanban-loop",
        "cards",
        "01HZX5K3QABCDEFGHJKMNPQRS0",
        "brief.md"
      );
      expect(resolveBriefPath(abs)).toBe(abs);
    } finally {
      if (prev === undefined) delete process.env.GARRISON_HOME;
      else process.env.GARRISON_HOME = prev;
    }
  });

  it("rejects paths OUTSIDE a briefs/ directory", () => {
    expect(resolveBriefPath(path.join(HOME, ".ssh", "id_rsa.md"))).toBeNull();
    expect(resolveBriefPath(path.join(HOME, "notes", "note.md"))).toBeNull();
  });

  it("rejects non-.md files even inside briefs/", () => {
    expect(resolveBriefPath(path.join(briefsDir, "secrets.json"))).toBeNull();
    expect(resolveBriefPath(path.join(briefsDir, "run.sh"))).toBeNull();
  });

  it("rejects traversal, absolute-escape, and non-absolute inputs", () => {
    expect(resolveBriefPath(path.join(briefsDir, "..", "..", "..", "etc", "x.md"))).toBeNull();
    expect(resolveBriefPath("/etc/briefs/passwd.md")).toBeNull(); // not under home
    expect(resolveBriefPath("briefs/rel.md")).toBeNull(); // relative
    expect(resolveBriefPath("")).toBeNull();
    expect(resolveBriefPath(null as any)).toBeNull();
    expect(resolveBriefPath("../../briefs/x.md")).toBeNull();
  });
});

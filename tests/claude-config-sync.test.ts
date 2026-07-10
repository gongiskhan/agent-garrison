// S8 (GARRISON-UNIFY-V1) — garrison config drift sync (D25).
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeDrift,
  driftIsClean,
  configPull,
  configCaptureIntoPayload,
  writeBreadcrumb,
  formatStatus,
  generateCommitMessage,
  BREADCRUMB_NAME
} from "../src/lib/claude-config-sync";

let home: string;
let payload: string;

function file(root: string, rel: string, body: string) {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body, "utf8");
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cc-home-"));
  payload = mkdtempSync(join(tmpdir(), "cc-payload-"));
});

describe("garrison config drift sync (S8)", () => {
  it("clean when home and payload match", async () => {
    file(home, "commands/x.md", "same");
    file(payload, "commands/x.md", "same");
    const drift = await computeDrift(home, payload);
    expect(driftIsClean(drift)).toBe(true);
    expect(drift.unchanged).toContain("commands/x.md");
  });

  it("detects added-in-home, added-in-payload, modified", async () => {
    file(home, "commands/new.md", "home-only");
    file(home, "commands/both.md", "home-version");
    file(payload, "commands/both.md", "seed-version");
    file(payload, "agents/seed.md", "seed-only");
    const drift = await computeDrift(home, payload);
    expect(drift.addedInHome).toEqual(["commands/new.md"]);
    expect(drift.addedInPayload).toEqual(["agents/seed.md"]);
    expect(drift.modified).toEqual(["commands/both.md"]);
    expect(driftIsClean(drift)).toBe(false);
  });

  it("mcp.json (single-file mirror) participates in drift", async () => {
    file(home, "mcp.json", "{}");
    file(payload, "mcp.json", "{\"a\":1}");
    const drift = await computeDrift(home, payload);
    expect(drift.modified).toContain("mcp.json");
  });

  it("ignores non-mirrored subpaths (skills, settings-fragments, sessions)", async () => {
    file(home, "skills/foo/SKILL.md", "not mirrored");
    file(payload, "settings-fragments/x.json", "managed only");
    const drift = await computeDrift(home, payload);
    expect(driftIsClean(drift)).toBe(true);
  });

  it("pull writes the payload into ~/.claude, only differing files", async () => {
    file(payload, "commands/a.md", "A");
    file(payload, "commands/b.md", "B");
    file(home, "commands/a.md", "A"); // already in sync
    const written = await configPull(home, payload);
    expect(written).toEqual(["commands/b.md"]);
    expect(readFileSync(join(home, "commands/b.md"), "utf8")).toBe("B");
  });

  it("commit captures ~/.claude drift into the payload (added + modified)", async () => {
    file(home, "commands/new.md", "captured");
    file(home, "agents/edit.md", "home-edit");
    file(payload, "agents/edit.md", "old");
    const written = await configCaptureIntoPayload(home, payload);
    expect(written.sort()).toEqual(["agents/edit.md", "commands/new.md"]);
    expect(readFileSync(join(payload, "commands/new.md"), "utf8")).toBe("captured");
    expect(readFileSync(join(payload, "agents/edit.md"), "utf8")).toBe("home-edit");
    // after capture, drift is clean
    expect(driftIsClean(await computeDrift(home, payload))).toBe(true);
  });

  it("writeBreadcrumb lands a README naming the command", async () => {
    const p = await writeBreadcrumb(home);
    expect(existsSync(p)).toBe(true);
    const body = readFileSync(p, "utf8");
    expect(body).toContain("Garrison-managed");
    expect(body).toContain("garrison config status");
    expect(body).toContain("claude-share");
    expect(p.endsWith(BREADCRUMB_NAME)).toBe(true);
  });

  it("formatStatus + generateCommitMessage render usefully", async () => {
    file(home, "commands/new.md", "x");
    const drift = await computeDrift(home, payload);
    expect(formatStatus(drift)).toContain("commands/new.md");
    expect(formatStatus({ addedInHome: [], addedInPayload: [], modified: [], unchanged: [] })).toContain("in sync");
    const msg = generateCommitMessage(["commands/new.md", "agents/x.md"]);
    expect(msg).toContain("sync 2 ~/.claude files");
    expect(msg).toContain("- commands/new.md");
  });
});

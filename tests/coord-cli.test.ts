import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// CO5 — the `coord` observability CLI: canary self-test + status layers + tail.

const COORD = path.resolve(__dirname, "..", "fittings", "seed", "coord-mcp", "scripts", "coord.mjs");

let gh: string; // sandbox GARRISON_HOME
let ch: string; // sandbox GARRISON_CLAUDE_HOME (empty projects -> Layer 2 controlled)

function slug(repo: string): string {
  return crypto.createHash("sha1").update(path.resolve(repo)).digest("hex").slice(0, 16);
}
function run(args: string[]): string {
  return execFileSync(process.execPath, [COORD, ...args], {
    env: { ...process.env, GARRISON_HOME: gh, GARRISON_CLAUDE_HOME: ch },
    encoding: "utf8"
  });
}

beforeEach(() => {
  gh = mkdtempSync(path.join(tmpdir(), "coord-cli-gh-"));
  ch = mkdtempSync(path.join(tmpdir(), "coord-cli-ch-"));
  mkdirSync(path.join(ch, "projects"), { recursive: true });
});
afterEach(() => {
  rmSync(gh, { recursive: true, force: true });
  rmSync(ch, { recursive: true, force: true });
});

describe("coord canary", () => {
  it("self-tests the write->detect->inject chain and prints COORD-CANARY OK", () => {
    const out = run(["canary"]);
    expect(out).toContain("COORD-CANARY OK");
  });

  it("leaves ZERO synthetic records behind (intents, plans, locks, AND heartbeat)", async () => {
    run(["canary"]);
    const fs = await import("node:fs");
    // No throwaway-repo ledgers remain.
    for (const sub of ["intents", "plans", "plan-locks"]) {
      const dir = path.join(gh, "coord", sub);
      const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      expect(files).toEqual([]);
    }
    // No synthetic heartbeat entries (canary-C / the throwaway repo) remain.
    const hbPath = path.join(gh, "coord", "heartbeat.log");
    const hb = fs.existsSync(hbPath) ? fs.readFileSync(hbPath, "utf8") : "";
    expect(hb).not.toContain("canary-C");
    expect(hb).not.toContain("coord-canary-repo");
  });
});

describe("coord status", () => {
  it("shows liveness + a seeded planning-lock holder and waiter (layer 1 + layer 5)", () => {
    const repo = "/work/projectX";
    const lockDir = path.join(gh, "coord", "plan-locks");
    mkdirSync(lockDir, { recursive: true });
    const future = new Date(Date.now() + 600000).toISOString();
    writeFileSync(
      path.join(lockDir, `${slug(repo)}.json`),
      JSON.stringify({ repo, session: "HOLDER-SESS", summary: "big refactor", startedAt: new Date().toISOString(), expiresAt: future, ttlMs: 600000 })
    );
    writeFileSync(
      path.join(lockDir, `${slug(repo)}.waiters.json`),
      JSON.stringify({ "WAITER-SESS": { summary: "other work", since: new Date().toISOString() } })
    );
    const out = run(["status"]);
    expect(out).toContain("Liveness");
    expect(out).toContain("agent_mail");
    expect(out).toContain("Planning locks");
    expect(out).toContain("HOLDER-SESS");
    expect(out).toContain("WAITER-SESS");
    expect(out).toContain(repo);
  });

  it("flags a STALE (expired) lock", () => {
    const repo = "/work/stale";
    const lockDir = path.join(gh, "coord", "plan-locks");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      path.join(lockDir, `${slug(repo)}.json`),
      JSON.stringify({ repo, session: "GHOST", summary: "abandoned", startedAt: new Date(0).toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString(), ttlMs: 1000 })
    );
    const out = run(["status"]);
    expect(out).toContain("STALE");
    expect(out).toContain("GHOST");
  });
});

describe("coord status --tail", () => {
  it("tails the hook heartbeat log (layer 3)", () => {
    mkdirSync(path.join(gh, "coord"), { recursive: true });
    writeFileSync(
      path.join(gh, "coord", "heartbeat.log"),
      JSON.stringify({ ts: new Date().toISOString(), event: "SessionStart", session: "HB-SESS", repo: "/r", conflicts: 2, digestBytes: 410 }) + "\n"
    );
    const out = run(["status", "--tail"]);
    expect(out).toContain("heartbeat");
    expect(out).toContain("HB-SESS");
    expect(out).toContain("conflicts=2");
  });
});

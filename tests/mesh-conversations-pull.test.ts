import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
let home: string;
let source: string;
let env: NodeJS.ProcessEnv;
const script = path.resolve("scripts/mesh-evidence-backup.sh");
const old = new Date(Date.now() - 20 * 86400000);
function put(p: string, text = "fixture") { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); fs.utimesSync(p, old, old); }
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-pull-"));
  source = `${home}/peer`;
  env = { NODE_ENV: "test", PATH: process.env.PATH, HOME: home, GARRISON_HOME: `${home}/.garrison`, GARRISON_CLAUDE_HOME: `${home}/.claude`, RSYNC_TARGET_OVERRIDE: source };
  put(`${source}/.garrison/conversations/chat-one/log.jsonl`);
  put(`${source}/.garrison/conversations/chat-one/ledger.json`);
  put(`${source}/.garrison/conversations/chat-one/work/private.txt`);
  put(`${source}/.garrison/conversations/chat-one/incomplete.part`);
  put(`${source}/.garrison/runs/one/evidence/report.json`);
  fs.mkdirSync(`${source}/.walkthrough/runs`, { recursive: true });
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
it("previews without copying or pruning, then keeps old conversations after evidence expires", () => {
  const staleEvidence = `${home}/.garrison/mesh-evidence/test-peer/garrison/old.txt`;
  put(staleEvidence);
  const preview = spawnSync("bash", [script, "unused", "test-peer", "--dry-run"], { env, encoding: "utf8" });
  expect(preview.status, preview.stderr).toBe(0);
  expect(preview.stdout).toContain("log.jsonl");
  expect(fs.existsSync(staleEvidence)).toBe(true);
  const sink = `${home}/.garrison/mesh-conversations/test-peer/chat-one`;
  expect(fs.existsSync(`${sink}/log.jsonl`)).toBe(false);
  const run = spawnSync("bash", [script, "unused", "test-peer"], { env, encoding: "utf8" });
  expect(run.status, run.stderr).toBe(0);
  expect(fs.readFileSync(`${sink}/log.jsonl`, "utf8")).toBe("fixture");
  expect(fs.existsSync(`${sink}/ledger.json`)).toBe(true);
  expect(fs.existsSync(`${sink}/work/private.txt`)).toBe(false);
  expect(fs.existsSync(`${sink}/incomplete.part`)).toBe(false);
  expect(fs.existsSync(staleEvidence)).toBe(false);
  expect(fs.existsSync(`${home}/.garrison/mesh-evidence/test-peer/garrison/runs/one/evidence/report.json`)).toBe(false);
  expect(fs.existsSync(`${source}/.garrison/conversations/chat-one/work/private.txt`)).toBe(true);
});
it("rejects a node name that could escape the sink", () => {
  expect(spawnSync("bash", [script, "unused", "../elsewhere"], { env }).status).toBe(2);
});

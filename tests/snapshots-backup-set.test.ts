import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

const scripts = path.resolve("fittings/seed/snapshots-default/scripts");
let home: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-set-"));
  fs.mkdirSync(path.join(home, "bin"));
  fs.mkdirSync(path.join(home, ".claude"));
  fs.mkdirSync(path.join(home, "dev"));
  fs.writeFileSync(path.join(home, "bin/restic"), `#!/usr/bin/env node\nconst fs=require('fs');fs.appendFileSync(process.env.ARGV_LOG,JSON.stringify(process.argv.slice(2))+'\\n');console.log('{}');`, { mode: 0o755 });
  env = { NODE_ENV: "test", PATH: `${home}/bin:${process.env.PATH}`, HOME: home, GARRISON_HOME: `${home}/.garrison`, GARRISON_CLAUDE_HOME: `${home}/.claude`, GARRISON_STATE_HOME: `${home}/.garrison-state`, RESTIC_REPOSITORY: `${home}/repo`, RESTIC_PASSWORD: "fixture-only", ARGV_LOG: `${home}/argv.jsonl` };
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

it.each([false, true])("includes optional backup paths exactly when present (%s)", (present) => {
  const optional = [`${home}/.garrison-state/backups`, `${home}/.garrison/mesh-conversations`];
  if (present) optional.forEach(p => fs.mkdirSync(p, { recursive: true }));
  const result = spawnSync("bash", [`${scripts}/backup.sh`], { env, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  const calls: string[][] = fs.readFileSync(`${home}/argv.jsonl`, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const argv = calls.find(call => call[0] === "backup")!;
  for (const p of optional) expect(argv.filter(v => v === p)).toHaveLength(present ? 1 : 0);
  expect(argv).not.toContain(`${home}/.garrison-state`);
  expect(argv).not.toContain(`${home}/.garrison-state/garrison.db`);
  const excludes = fs.readFileSync(`${scripts}/excludes.txt`, "utf8").split("\n");
  expect(excludes).toContain("**/.garrison/runtime-homes/**/projects/**/*.jsonl");
  expect(excludes).toContain("**/.garrison/stretch-claude/**");
});

it.each([0, 1])("refreshes the daily snapshot first and aborts if it fails (exit %s)", (code) => {
  const stateScripts = `${home}/.garrison-state/current/scripts`;
  fs.mkdirSync(stateScripts, { recursive: true });
  fs.writeFileSync(`${stateScripts}/backup.mjs`, `import fs from 'node:fs';fs.appendFileSync(process.env.ARGV_LOG,JSON.stringify(['daily',...process.argv.slice(2)])+'\\n');process.exit(${code});`);
  const result = spawnSync("bash", [`${scripts}/backup.sh`], { env, encoding: "utf8" });
  expect(result.status).toBe(code);
  const calls: string[][] = fs.readFileSync(`${home}/argv.jsonl`, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(calls[0]).toEqual(["daily", "--daily"]);
  expect(calls.some(call => call[0] === "backup")).toBe(code === 0);
  expect(JSON.parse(fs.readFileSync(`${home}/.garrison/snapshots/state.json`, "utf8")).ok).toBe(code === 0);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { spawnSync } from "node:child_process";

const FITTING = path.resolve("fittings/seed/codex-runtime");
const EVENTS = ["SessionStart", "UserPromptSubmit", "PostToolUse", "PreCompact", "Stop", "SessionEnd"];
const POLICY = "<!-- GARRISON_AGENT_CONTINUITY_START -->\nUse the shared topic.\n<!-- GARRISON_AGENT_CONTINUITY_END -->";
async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "garrison-continuity-home-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installed = path.join(root, "composition/apm_modules/_local/codex-runtime");
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.cpSync(FITTING, installed, { recursive: true });
  const { ensureCodexContinuityHome: ensure } = await import(pathToFileURL(path.join(installed, "lib/continuity-home.mjs")));
  const native = path.join(root, ".codex");
  const target = path.join(root, "runtime/account");
  fs.mkdirSync(native); fs.mkdirSync(target, { recursive: true });
  const hooks = Object.fromEntries(EVENTS.map((event) => [event, [{ hooks: [
    { type: "command", command: "python3 /owned/agent-continuity.py hook --source Codex", timeout: 2 }
  ] }]]));
  hooks.PermissionRequest = [{ hooks: [{ command: "unrelated-native-approval" }] }];
  fs.writeFileSync(path.join(native, "hooks.json"), JSON.stringify({ hooks }));
  fs.writeFileSync(path.join(native, "AGENTS.md"), POLICY + "\nPRIVATE NATIVE CONTEXT NOT PROJECTED");
  fs.mkdirSync(path.join(root, ".config/garrison"), { recursive: true });
  fs.writeFileSync(path.join(root, ".config/garrison/agent-continuity.json"), JSON.stringify({ version: 1, ssh_host: "dev-madrid", basic_memory_command: ["/home/user/.local/bin/basic-memory"] }));
  return { root, native, target, ensure: (env = {}) => ensure({ userHome: root, targetHome: target, env }) };
}

function memoryServer(f) {
  const parsed = spawnSync("python3", ["-c", "import json,sys,tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())['mcp_servers']['basic-memory']))"], {
    input: fs.readFileSync(path.join(f.target, "config.toml"), "utf8"), encoding: "utf8",
  });
  assert.equal(parsed.status, 0, parsed.stderr);
  return JSON.parse(parsed.stdout);
}

test("installed fitting projects only owned hooks/context and leaves account auth and MCPs intact", async (t) => {
  const f = await fixture(t);
  const auth = '{"tokens":"independent-test-identity"}\n';
  fs.writeFileSync(path.join(f.target, "auth.json"), auth);
  const config = 'model = "account-model"\n\n[mcp_servers.custom]\ncommand = "my-tool"\n\n[mcp_servers.basic-memory]\ncommand = "account-owned-memory"\nargs = ["custom"]\n';
  fs.writeFileSync(path.join(f.target, "config.toml"), config);
  fs.writeFileSync(path.join(f.target, "hooks.json"), JSON.stringify({ ownSetting: true, hooks: {
    SessionStart: [{ hooks: [{ command: "keep-native-session-controller" }, { command: "python3 /old/agent-continuity.py hook" }] }],
    Stop: [{ hooks: [{ command: "keep-user-stop-hook" }] }]
  } }));
  fs.writeFileSync(path.join(f.target, "AGENTS.md"), "Account-owned instructions\n");
  const first = f.ensure();
  assert.equal(first.enrolled, true);
  const hooks = JSON.parse(fs.readFileSync(path.join(f.target, "hooks.json"), "utf8"));
  assert.equal(hooks.ownSetting, true);
  assert.match(JSON.stringify(hooks), /keep-native-session-controller/);
  assert.match(JSON.stringify(hooks), /keep-user-stop-hook/);
  assert.doesNotMatch(JSON.stringify(hooks), /unrelated-native-approval|\/old\//);
  assert.equal(fs.readFileSync(path.join(f.target, "auth.json"), "utf8"), auth);
  assert.match(fs.readFileSync(path.join(f.target, "config.toml"), "utf8"), /account-owned-memory/);
  assert.match(fs.readFileSync(path.join(f.target, "config.toml"), "utf8"), /account-model/);
  assert.match(fs.readFileSync(path.join(f.target, "AGENTS.md"), "utf8"), /Account-owned instructions/);
  assert.doesNotMatch(fs.readFileSync(path.join(f.target, "AGENTS.md"), "utf8"), /PRIVATE NATIVE CONTEXT/);
  const second = f.ensure();
  assert.equal(second.hookChanged, false); assert.equal(second.contextChanged, false); assert.equal(second.configChanged, false);
});

test("a new account home receives only the configured shared transport, and inline existing memory is preserved", async (t) => {
  const f = await fixture(t);
  f.ensure();
  const config = fs.readFileSync(path.join(f.target, "config.toml"), "utf8");
  assert.match(config, /project_doc_max_bytes = 65536/);
  assert.match(config, /command = "\/usr\/bin\/ssh"/);
  assert.match(config, /dev-madrid/);
  assert.equal(fs.existsSync(path.join(f.target, "auth.json")), false);
  assert.equal(f.ensure().configChanged, false);
  fs.writeFileSync(path.join(f.target, "config.toml"), '[mcp_servers]\nbasic-memory = { command = "keep-inline" }\n');
  f.ensure();
  const inline = fs.readFileSync(path.join(f.target, "config.toml"), "utf8");
  assert.match(inline, /keep-inline/); assert.doesNotMatch(inline, /\[mcp_servers.basic-memory\]/);
});

test("partial source and symlinked target config fail before changing target files", async (t) => {
  const f = await fixture(t);
  const sourcePath = path.join(f.native, "hooks.json");
  const full = fs.readFileSync(sourcePath, "utf8");
  fs.writeFileSync(sourcePath, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: "agent-continuity.py" }] }] } }));
  assert.throws(f.ensure, /incomplete/);
  assert.deepEqual(fs.readdirSync(f.target), []);
  fs.writeFileSync(sourcePath, full);
  fs.writeFileSync(path.join(f.root, "private-settings"), 'model="unchanged"');
  fs.symlinkSync(path.join(f.root, "private-settings"), path.join(f.target, "config.toml"));
  assert.throws(f.ensure, /symlinked/);
  assert.equal(fs.existsSync(path.join(f.target, "hooks.json")), false);
  assert.equal(fs.readFileSync(path.join(f.root, "private-settings"), "utf8"), 'model="unchanged"');
});

test("valid quoted, inline and indented TOML stays byte-for-byte intact", async (t) => {
  const f = await fixture(t);
  const samples = [
    'project_doc_max_bytes = 100000\nmcp_servers = { custom = { command = "keep" } }\n',
    '  project_doc_max_bytes = 100000\nmcp_servers = { basic-memory = { command = "owned" } }\n',
    '"project_doc_max_bytes" = 100_000\n["mcp_servers"."basic-memory"]\ncommand="owned"\n',
    "'project_doc_max_bytes' = +100000\n[mcp_servers]\nbasic-memory={command='owned'}\n"
  ];
  for (const sample of samples) {
    fs.writeFileSync(path.join(f.target, "config.toml"), sample);
    f.ensure();
    assert.equal(fs.readFileSync(path.join(f.target, "config.toml"), "utf8"), sample);
  }
});

test("unenrolled installations remain a no-op even with symlinked target config", async (t) => {
  const f = await fixture(t);
  fs.unlinkSync(path.join(f.native, "hooks.json"));
  const config = path.join(f.root, "other-config");
  fs.writeFileSync(config, 'model="user-model"');
  fs.symlinkSync(config, path.join(f.target, "config.toml"));
  assert.equal(f.ensure().reason, "not-installed");
  assert.equal(fs.readFileSync(config, "utf8"), 'model="user-model"');
  assert.equal(fs.existsSync(path.join(f.target, "hooks.json")), false);
});

test("owned local memory selects the shared authority despite an isolated gateway environment", async (t) => {
  const f = await fixture(t);
  const config = path.join(f.root, ".config/garrison/agent-continuity.json");
  const bridge = { version: 1, basic_memory_command: [process.execPath, "-e", "process.stdout.write(process.env.BASIC_MEMORY_CONFIG_DIR)", "--"] };
  fs.writeFileSync(config, JSON.stringify(bridge));
  const inherited = { ...process.env, BASIC_MEMORY_CONFIG_DIR: "/isolated/gateway/memory", BASIC_MEMORY_HOME: "/isolated/home", XDG_CONFIG_HOME: "/isolated/xdg" };
  f.ensure(inherited);
  let server = memoryServer(f);
  assert.deepEqual(server.env, { BASIC_MEMORY_CONFIG_DIR: path.join(f.root, ".basic-memory") });
  const launched = spawnSync(server.command, server.args, { encoding: "utf8", env: { ...inherited, ...server.env } });
  assert.equal(launched.status, 0, launched.stderr);
  assert.equal(launched.stdout, path.join(f.root, ".basic-memory"));
  assert.equal(f.ensure(inherited).configChanged, false);
  const authority = path.join(f.root, "shared authority's config");
  fs.writeFileSync(config, JSON.stringify({ ...bridge, basic_memory_config_dir: authority }));
  assert.equal(f.ensure(inherited).memoryMcp, "owned-updated");
  server = memoryServer(f);
  assert.deepEqual(server.env, { BASIC_MEMORY_CONFIG_DIR: authority });
  assert.equal(f.ensure(inherited).configChanged, false);
});

test("an explicit SSH authority directory is quoted remotely and unowned per-account environments remain untouched", async (t) => {
  const f = await fixture(t);
  const config = path.join(f.root, ".config/garrison/agent-continuity.json");
  const authority = "/remote/shared authority's config";
  fs.writeFileSync(config, JSON.stringify({ version: 1, ssh_host: "dev-madrid", basic_memory_command: ["/remote/basic-memory"], basic_memory_config_dir: authority }));
  f.ensure();
  const server = memoryServer(f);
  assert.equal(server.env, undefined);
  const parsed = spawnSync("python3", ["-c", "import json,sys,shlex; print(json.dumps(shlex.split(sys.stdin.read())))"], { input: server.args.at(-1), encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.deepEqual(JSON.parse(parsed.stdout), ["env", `BASIC_MEMORY_CONFIG_DIR=${authority}`, "/remote/basic-memory", "mcp"]);
  const own = 'project_doc_max_bytes = 65536\n[mcp_servers.basic-memory]\ncommand = "account-owned"\nenv = { BASIC_MEMORY_CONFIG_DIR = "/account-owned/config" }\n';
  fs.writeFileSync(path.join(f.target, "config.toml"), own);
  assert.equal(f.ensure().memoryMcp, "preserved");
  assert.equal(fs.readFileSync(path.join(f.target, "config.toml"), "utf8"), own);
});

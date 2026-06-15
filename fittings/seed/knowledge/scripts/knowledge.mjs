#!/usr/bin/env node
// knowledge.mjs — the Knowledge faculty CLI (BRIEF v4). Owns the canonical vault,
// emits cross-runtime projections, wires the shared MCP servers into a project,
// and provisions a project on first touch (idempotent, safe to re-run).
//
//   knowledge.mjs project   --vault <dir> --out <dir>
//   knowledge.mjs harvest   --memory <MEMORY.md> --vault <dir>
//   knowledge.mjs provision --project <dir> [--vault <dir>]   (idempotent first-touch)
//   knowledge.mjs --probe
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { projectAll, writeProjections, SENTINELS } from "../lib/projections.mjs";
import { harvestIntoVault } from "../lib/harvest.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED_VAULT = path.join(HERE, "..", "vault");

// The shared MCP servers the Knowledge faculty federates into every runtime
// session (memory/Knowledge + CodeGraph + Serena). codegraph/serena are wired
// as available; consumers that lack them simply don't see those tools.
function knowledgeMcpServers() {
  return {
    knowledge: { command: "node", args: [path.join(HERE, "mcp-server.mjs")], env: {} },
    // Verified live (U2): codegraph's MCP stdio server is `serve --mcp`
    // (codegraph install --print-config), NOT `mcp`; serena's is
    // `start-mcp-server` with the agent context + dashboard off. The active
    // project is activated from the session cwd (or serena's activate_project).
    codegraph: { command: "codegraph", args: ["serve", "--mcp"], env: {} },
    serena: {
      command: "serena",
      args: ["start-mcp-server", "--context", "ide-assistant", "--enable-web-dashboard", "False"],
      env: {}
    }
  };
}

// Idempotent MCP wiring: merge our servers into <project>/.mcp.json, only adding
// the ones not already present. Returns { added: [...], present: [...] }.
function wireMcp(projectDir) {
  const file = path.join(projectDir, ".mcp.json");
  let doc = { mcpServers: {} };
  if (existsSync(file)) {
    try {
      doc = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      doc = { mcpServers: {} };
    }
  }
  doc.mcpServers = doc.mcpServers || {};
  const added = [];
  const present = [];
  for (const [name, cfg] of Object.entries(knowledgeMcpServers())) {
    if (doc.mcpServers[name]) present.push(name);
    else {
      doc.mcpServers[name] = cfg;
      added.push(name);
    }
  }
  if (added.length) writeFileSync(file, JSON.stringify(doc, null, 2) + "\n", "utf8");
  return { added, present };
}

function provision(projectDir, vaultDir) {
  mkdirSync(projectDir, { recursive: true });
  const projections = projectAll(vaultDir);
  const proj = writeProjections(projectDir, projections);
  const mcp = wireMcp(projectDir);
  // verify each projection is readable + carries its sentinel
  const verify = {};
  for (const [name, sentinelKey] of [["AGENTS.md", "agents"], ["CLAUDE.md", "claude"], ["GEMINI.md", "gemini"]]) {
    const p = path.join(projectDir, name);
    verify[name] = existsSync(p) && readFileSync(p, "utf8").includes(SENTINELS[sentinelKey]);
  }
  const noop = proj.written.length === 0 && mcp.added.length === 0;
  return { projections: proj, mcp, verify, noop };
}

function arg(flags, name, fallback) {
  const i = flags.indexOf(name);
  return i >= 0 ? flags[i + 1] : fallback;
}

function main() {
  const [cmd, ...flags] = process.argv.slice(2);
  if (process.argv.includes("--probe") || cmd === "--probe") {
    // probe: the seed vault projects cleanly (sentinels present)
    const projections = projectAll(SEED_VAULT);
    const ok = projections["AGENTS.md"].includes(SENTINELS.agents) && projections["CLAUDE.md"].includes("@AGENTS.md");
    if (!ok) {
      console.error("knowledge probe failed: projection sentinel/import missing");
      process.exit(1);
    }
    console.log("ok");
    return;
  }
  if (cmd === "project") {
    const vault = arg(flags, "--vault", SEED_VAULT);
    const out = arg(flags, "--out", process.cwd());
    const r = writeProjections(out, projectAll(vault));
    console.log(JSON.stringify(r));
    return;
  }
  if (cmd === "harvest") {
    const memory = arg(flags, "--memory");
    const vault = arg(flags, "--vault", SEED_VAULT);
    const r = harvestIntoVault(memory, vault);
    console.log(JSON.stringify(r));
    return;
  }
  if (cmd === "provision") {
    const project = arg(flags, "--project", process.cwd());
    const vault = arg(flags, "--vault", SEED_VAULT);
    console.log(JSON.stringify(provision(project, vault)));
    return;
  }
  console.error("usage: knowledge.mjs project|harvest|provision|--probe");
  process.exit(2);
}

// Only run the CLI when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { provision, wireMcp, knowledgeMcpServers };

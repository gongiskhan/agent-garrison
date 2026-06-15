// U2 live probe — codegraph + serena answer queries through the wired MCP.
// Prints codegraph-ok / serena-ok (the BRIEF-v4 tool-blocked tokens, now green)
// for the walkthrough. Re-runnable: node scripts/probe-knowledge-mcp.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpStdioClient, flattenContent } from "./lib/mcp-stdio-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const FIXTURE = path.join(ROOT, "tests/fixtures/kg-project");

const project = mkdtempSync(path.join(tmpdir(), "gar-kg-probe-"));
cpSync(path.join(FIXTURE, "src"), path.join(project, "src"), { recursive: true });
cpSync(path.join(FIXTURE, "package.json"), path.join(project, "package.json"));

async function codegraph() {
  execFileSync("codegraph", ["init", "."], { cwd: project, stdio: "ignore" });
  const c = new McpStdioClient({ command: "codegraph", args: ["serve", "--mcp", "-p", project], cwd: project, name: "codegraph" });
  c.start();
  try {
    await c.initialize({ rootUri: pathToFileURL(project).href, timeoutMs: 60_000 });
    await c.listTools(60_000);
    const r = await c.callTool("codegraph_explore", { query: "addNumbers" }, 150_000);
    const t = flattenContent(r);
    return t.includes("addNumbers") && /math\.ts/.test(t);
  } finally {
    c.stop();
  }
}

async function serena() {
  const c = new McpStdioClient({
    command: "serena",
    args: ["start-mcp-server", "--context", "ide-assistant", "--enable-web-dashboard", "False", "--project", project, "--transport", "stdio"],
    cwd: project,
    name: "serena",
  });
  c.start();
  try {
    await c.initialize({ timeoutMs: 120_000 });
    await c.listTools(90_000);
    const r = await c.callTool("find_symbol", { name_path_pattern: "addNumbers", include_body: true }, 150_000);
    const t = flattenContent(r);
    return t.includes("addNumbers") && /math\.ts/.test(t);
  } finally {
    c.stop();
  }
}

try {
  const cg = await codegraph().catch((e) => (console.error("[codegraph]", e.message), false));
  console.log(cg ? "codegraph-ok" : "codegraph-FAILED");
  const sr = await serena().catch((e) => (console.error("[serena]", e.message), false));
  console.log(sr ? "serena-ok" : "serena-FAILED");
  setTimeout(() => process.exit(0), 500).unref();
} catch (err) {
  console.error("probe error:", err?.message);
  process.exit(1);
}

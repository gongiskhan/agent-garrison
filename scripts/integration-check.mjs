import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSITION_ID = process.argv[2] ?? "default";
const GATEWAY_URL = (process.env.GARRISON_GATEWAY_URL ?? "http://127.0.0.1:24777").replace(/\/$/, "");
const COMPOSITION_DIR = path.join(REPO_ROOT, "compositions", COMPOSITION_ID);

const results = [];

function record(name, status, detail, evidence) {
  results.push({ name, status, detail, evidence });
}

function truncate(value, max = 400) {
  const str = typeof value === "string" ? value : JSON.stringify(value);
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function checkAuth() {
  if (process.env.ANTHROPIC_API_KEY) {
    record(
      "Auth source",
      "fail",
      "ANTHROPIC_API_KEY is set — turns will bill against the API key, not your Max plan.",
      "Unset ANTHROPIC_API_KEY in this shell (and ~/.zshrc / ~/.bashrc if exported there) before running the operative."
    );
    return;
  }
  const claudeDir =
    process.env.GARRISON_CLAUDE_HOME?.trim() ||
    process.env.CLAUDE_CONFIG_DIR?.trim() ||
    path.join(os.homedir(), ".claude");
  const claudeDirLabel =
    claudeDir === path.join(os.homedir(), ".claude") ? "~/.claude" : claudeDir;
  if (await pathExists(claudeDir)) {
    record(
      "Auth source",
      "pass",
      "Agent SDK will use Claude Code OAuth credentials.",
      `${claudeDirLabel} exists and ANTHROPIC_API_KEY is unset.`
    );
    return;
  }
  record(
    "Auth source",
    "warn",
    "Not authenticated at all.",
    `ANTHROPIC_API_KEY is unset and ${claudeDirLabel} is missing — run \`claude\` once with this instance's config home to log in.`
  );
}

async function checkAssembledPrompt() {
  const promptPath = path.join(COMPOSITION_DIR, ".garrison", "assembled-system-prompt.md");
  if (!(await pathExists(promptPath))) {
    record(
      "Assembled system prompt",
      "fail",
      `Missing ${path.relative(REPO_ROOT, promptPath)}`,
      "Run the operative once (Run button in the Garrison UI) to generate the assembled prompt."
    );
    return;
  }
  const contents = await fs.readFile(promptPath, "utf8");
  const missing = [];
  if (!contents.includes("[orchestrator-active]")) missing.push("[orchestrator-active] marker");
  if (!contents.includes("Verity")) missing.push("Verity");
  if (missing.length > 0) {
    record(
      "Assembled system prompt",
      "warn",
      `Assembled prompt is present but missing: ${missing.join(", ")}`,
      `Run \`npm run refresh:prompts -- ${COMPOSITION_ID}\` and restart the operative.`
    );
    return;
  }
  record(
    "Assembled system prompt",
    "pass",
    "Assembled prompt contains the orchestrator marker and the Verity identity.",
    path.relative(REPO_ROOT, promptPath)
  );
}

// The routing section can ONLY break under the real Next server (webpack
// compiles the runner's fully-dynamic routing-core import into an empty lazy
// context unless webpackIgnore'd); vitest runs under plain node and can never
// catch it. So this live check asserts: whenever the composition's
// orchestrator prompt carries {{routing}}, the assembled prompt written by
// up() contains a non-empty compiled routing section.
async function checkRoutingSection() {
  const promptPath = path.join(COMPOSITION_DIR, ".garrison", "assembled-system-prompt.md");
  if (!(await pathExists(promptPath))) {
    record(
      "Routing section",
      "fail",
      `Missing ${path.relative(REPO_ROOT, promptPath)} - cannot verify the routing section.`,
      "Run the operative once (Run button in the Garrison UI) to generate the assembled prompt."
    );
    return;
  }
  // Mirror the runner's prompt resolution: the selected orchestrator fitting's
  // .apm/prompts/*.prompt.md, falling back to the composition's
  // .garrison/prompts/orchestrator.md.
  let source = null;
  let sourceLabel = "";
  try {
    const { load } = await import("js-yaml");
    const manifest = load(await fs.readFile(path.join(COMPOSITION_DIR, "apm.yml"), "utf8"));
    const selections = manifest?.["x-garrison"]?.composition?.selections ?? {};
    const orchestratorId = selections.orchestrator?.[0]?.id;
    if (orchestratorId) {
      const library = JSON.parse(
        await fs.readFile(path.join(REPO_ROOT, "data", "library.json"), "utf8")
      );
      const localPath = library.find((entry) => entry.id === orchestratorId)?.localPath;
      if (localPath) {
        const promptDir = path.join(REPO_ROOT, localPath, ".apm", "prompts");
        const promptFile = (await fs.readdir(promptDir)).find((file) =>
          file.endsWith(".prompt.md")
        );
        if (promptFile) {
          source = await fs.readFile(path.join(promptDir, promptFile), "utf8");
          sourceLabel = path.relative(REPO_ROOT, path.join(promptDir, promptFile));
        }
      }
    }
  } catch {
    // fall through to the composition fallback prompt
  }
  if (source === null) {
    try {
      const fallback = path.join(COMPOSITION_DIR, ".garrison", "prompts", "orchestrator.md");
      source = await fs.readFile(fallback, "utf8");
      sourceLabel = path.relative(REPO_ROOT, fallback);
    } catch {
      record(
        "Routing section",
        "warn",
        "Could not resolve the orchestrator prompt source; skipping the routing-section assertion.",
        ""
      );
      return;
    }
  }
  if (!source.includes("{{routing}}")) {
    record(
      "Routing section",
      "pass",
      "Orchestrator prompt has no {{routing}} placeholder; nothing to assert.",
      sourceLabel
    );
    return;
  }
  const assembled = await fs.readFile(promptPath, "utf8");
  const hasMarker = assembled.includes("<!-- garrison:routing");
  const hasPolicy = assembled.includes("## Routing policy");
  if (hasMarker && hasPolicy) {
    record(
      "Routing section",
      "pass",
      "Assembled prompt carries the compiled routing section for the {{routing}} placeholder.",
      `${sourceLabel} has {{routing}}; assembled prompt contains the garrison:routing marker + Routing policy section.`
    );
  } else {
    record(
      "Routing section",
      "fail",
      `${sourceLabel} carries {{routing}} but the assembled prompt has NO compiled routing section - the placeholder substituted to empty.`,
      "Check the runner log: 'routing compiler failed to load' means the routing-core dynamic import broke under the Next server (webpackIgnore regression); 'routing.json missing/invalid' means the config is bad."
    );
  }
}

async function checkGatewayHealth() {
  try {
    const response = await fetch(`${GATEWAY_URL}/health`, {
      signal: AbortSignal.timeout(3000)
    });
    if (!response.ok) {
      record(
        "Gateway health",
        "fail",
        `GET /health returned ${response.status}`,
        truncate(await response.text())
      );
      return false;
    }
    const body = await response.json();
    if (body?.ok !== true) {
      record("Gateway health", "fail", "GET /health did not return { ok: true }", truncate(body));
      return false;
    }
    record("Gateway health", "pass", `Gateway responding at ${GATEWAY_URL}`, `session_id=${body.session_id ?? "?"}, uptime_ms=${body.uptime_ms ?? "?"}`);
    return true;
  } catch (error) {
    record(
      "Gateway health",
      "fail",
      `Gateway unreachable at ${GATEWAY_URL}`,
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }
}

async function chat(message) {
  const response = await fetch(`${GATEWAY_URL}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
    signal: AbortSignal.timeout(120_000)
  });
  if (!response.ok) {
    throw new Error(`POST /chat returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function recordSkippedNetwork(name, reason = "skipped: gateway not reachable") {
  record(name, "fail", reason, "");
}

async function runNetworkChecks() {
  let turn1;
  try {
    turn1 = await chat("Briefly say hello.");
  } catch (error) {
    record("Orchestrator routing (turn 1)", "fail", "chat call failed", error instanceof Error ? error.message : String(error));
    recordSkippedNetwork("Soul + session resume (turn 2)", "skipped: turn 1 failed");
    recordSkippedNetwork("In-session memory", "skipped: turn 1 failed");
    return;
  }
  if (turn1.reply?.includes("[orchestrator-active]")) {
    record("Orchestrator routing (turn 1)", "pass", "Reply ended with the orchestrator marker.", `session_id=${turn1.session_id}`);
  } else {
    record(
      "Orchestrator routing (turn 1)",
      "fail",
      "Reply did NOT contain the [orchestrator-active] marker.",
      truncate(turn1.reply ?? "(empty reply)")
    );
  }

  let turn2;
  try {
    turn2 = await chat("What is your name?");
  } catch (error) {
    record("Soul + session resume (turn 2)", "fail", "chat call failed", error instanceof Error ? error.message : String(error));
    recordSkippedNetwork("In-session memory", "skipped: turn 2 failed");
    return;
  }
  const sameSession = turn2.session_id === turn1.session_id;
  const namedVerity = /\bVerity\b/i.test(turn2.reply ?? "");
  if (sameSession && namedVerity) {
    record("Soul + session resume (turn 2)", "pass", "Session resumed and operative identified as Verity.", `session_id=${turn2.session_id}`);
  } else {
    const misses = [];
    if (!sameSession) misses.push(`session_id changed: turn1=${turn1.session_id} turn2=${turn2.session_id}`);
    if (!namedVerity) misses.push(`reply did not contain "Verity": ${truncate(turn2.reply ?? "(empty reply)")}`);
    record("Soul + session resume (turn 2)", "fail", "Conditions failed.", misses.join(" | "));
  }

  try {
    await chat("Please remember: my favorite color is teal.");
  } catch (error) {
    record("In-session memory", "fail", "First memory chat call failed", error instanceof Error ? error.message : String(error));
    return;
  }
  let turn4;
  try {
    turn4 = await chat("What did I just tell you my favorite color was?");
  } catch (error) {
    record("In-session memory", "fail", "Second memory chat call failed", error instanceof Error ? error.message : String(error));
    return;
  }
  if (/\bteal\b/i.test(turn4.reply ?? "")) {
    record("In-session memory", "pass", "Operative recalled the color across turns within one session.", truncate(turn4.reply));
  } else {
    record("In-session memory", "fail", "Operative did not recall the color.", truncate(turn4.reply ?? "(empty reply)"));
  }
}

async function checkCrossSessionMemory() {
  const memoryPath = path.join(COMPOSITION_DIR, "memory", "compiled.md");
  if (!(await pathExists(memoryPath))) {
    record(
      "Cross-session memory file",
      "warn",
      "memory/compiled.md is missing.",
      "The memory Fitting in this milestone ships a SKILL.md only — there is no hook that writes durable memory yet. Cross-session recall is currently NOT working. This is the next milestone."
    );
    return;
  }
  const contents = await fs.readFile(memoryPath, "utf8");
  if (contents.trim().length === 0) {
    record(
      "Cross-session memory file",
      "warn",
      "memory/compiled.md exists but is empty.",
      "The memory Fitting describes persistence but no hook has written to it yet."
    );
    return;
  }
  record("Cross-session memory file", "pass", "memory/compiled.md exists with content.", path.relative(REPO_ROOT, memoryPath));
}

function indicator(status) {
  if (status === "pass") return "PASS";
  if (status === "fail") return "FAIL";
  return "WARN";
}

function printReport() {
  console.log("");
  console.log(`Agent Garrison integration check — composition: ${COMPOSITION_ID}`);
  console.log(`Gateway: ${GATEWAY_URL}`);
  console.log("");
  for (const result of results) {
    console.log(`[${indicator(result.status)}] ${result.name}`);
    console.log(`       ${result.detail}`);
    if (result.evidence) {
      console.log(`       evidence: ${result.evidence}`);
    }
  }
  const counts = results.reduce(
    (acc, r) => {
      acc[r.status] += 1;
      return acc;
    },
    { pass: 0, fail: 0, warn: 0 }
  );
  console.log("");
  console.log(`Summary: ${counts.pass} pass / ${counts.warn} warn / ${counts.fail} fail`);
}

async function main() {
  await checkAuth();
  await checkAssembledPrompt();
  await checkRoutingSection();
  const gatewayUp = await checkGatewayHealth();
  if (gatewayUp) {
    await runNetworkChecks();
  } else {
    recordSkippedNetwork("Orchestrator routing (turn 1)");
    recordSkippedNetwork("Soul + session resume (turn 2)");
    recordSkippedNetwork("In-session memory");
  }
  await checkCrossSessionMemory();
  printReport();
  const hasFail = results.some((r) => r.status === "fail");
  process.exit(hasFail ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});

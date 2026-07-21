#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export async function runProvider(provider) {
  if (process.argv.includes("--probe")) {
    process.stdout.write("ok\n");
    return;
  }

  let spec;
  try {
    spec = JSON.parse(await readStdin());
  } catch (error) {
    fail("invalid-task-spec", `task spec must be JSON on stdin: ${error.message}`);
  }

  const model = spec?.model;
  if (!model || typeof model !== "string") {
    fail("missing-model", "task spec must include provider-side model");
  }
  if (!provider.allowModels.includes(model)) {
    fail("model-not-allowed", `model ${model} is not allowed`, { allowed: provider.allowModels });
  }

  const keyState = checkKey(provider);
  if (!keyState.ok) {
    fail(keyState.code, keyState.error);
  }

  const prompt = typeof spec.prompt === "string" ? spec.prompt : "";
  if (!prompt.trim()) fail("missing-prompt", "task spec must include prompt");

  const mock = process.env.GARRISON_PROVIDER_MOCK === "1";
  const output = mock
    ? `[mock:${provider.id}:${model}] ${prompt.slice(0, 500)}`
    : await invokeWithRetry(provider, { spec, model, prompt });

  const artifact = await writeArtifact(provider, output, spec);
  const summary = {
    ok: true,
    provider: provider.id,
    model,
    artifact_id: artifact.id,
    title: artifact.title,
    summary: summarize(output)
  };
  await appendDelegation(provider, {
    ts: new Date().toISOString(),
    provider: provider.id,
    model,
    target: spec.target ?? null,
    artifact_id: artifact.id,
    ok: true
  });
  process.stdout.write(JSON.stringify(summary) + "\n");
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function checkKey(provider) {
  if (process.env.GARRISON_VAULT_LOCKED === "1") {
    return { ok: false, code: "vault-locked", error: "vault locked; provider secret unavailable" };
  }
  if (!provider.keyEnv) return { ok: true };
  if (!process.env[provider.keyEnv] && process.env.GARRISON_PROVIDER_MOCK !== "1") {
    return { ok: false, code: "secret-absent", error: `${provider.keyEnv} is not set` };
  }
  return { ok: true };
}

async function writeArtifact(provider, output, spec) {
  const compositionDir = process.env.GARRISON_COMPOSITION_DIR ?? process.cwd();
  const filename = `${Date.now()}-${provider.id}.md`;
  const title = `${provider.label} delegation`;
  const artifactCli = process.env.GARRISON_ARTIFACTS_PY;
  if (artifactCli) {
    const result = await runArtifactCli(artifactCli, output, filename, title);
    if (result.ok) return { id: result.id, title };
  }
  const dir = path.join(compositionDir, "artifacts", "delegations");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, output, "utf8");
  const meta = {
    id: `delegations/${filename}`,
    filename,
    namespace: "delegations",
    producer: provider.id,
    mime: "text/markdown",
    title,
    created: new Date().toISOString(),
    task: spec.target ?? null
  };
  await fs.writeFile(`${filePath}.meta.json`, JSON.stringify(meta, null, 2), "utf8");
  return { id: meta.id, title };
}

async function runArtifactCli(artifactCli, output, filename, title) {
  return new Promise((resolve) => {
    const child = spawn("python3", [artifactCli, "write", "delegations", filename, "--title", title, "--mime", "text/markdown", "--producer", "orchestrator"], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.on("error", () => resolve({ ok: false }));
    child.on("close", (code) => {
      if (code !== 0) return resolve({ ok: false });
      resolve({ ok: true, id: stdout.trim() || `delegations/${filename}` });
    });
    child.stdin.end(output);
  });
}

async function appendDelegation(provider, record) {
  const compositionDir = process.env.GARRISON_COMPOSITION_DIR ?? process.cwd();
  const logPath = process.env.GARRISON_DECISIONS_LOG ?? path.join(compositionDir, ".garrison", "decisions.jsonl");
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, JSON.stringify({ ...record, kind: "delegation" }) + "\n", "utf8");
}

function summarize(output) {
  return output.replace(/\s+/g, " ").trim().slice(0, 400);
}

async function invokeWithRetry(provider, req) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await provider.invoke(req);
    } catch (error) {
      lastError = error;
    }
  }
  fail("provider-failed", lastError instanceof Error ? lastError.message : String(lastError));
}

function fail(code, error, extra = {}) {
  process.stderr.write(JSON.stringify({ ok: false, code, error, ...extra }) + "\n");
  process.exit(1);
}

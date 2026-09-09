#!/usr/bin/env node
// A conversation must not own the process that restarts its gateway. The
// existing reload/redeploy entry points hand hosted work to an OS-owned job.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { openConversation } from "../packages/claude-pty/src/conversation-store.mjs";
import { parkConversation } from "../fittings/seed/http-gateway/scripts/lib/conversation-recovery.mjs";

const script = fileURLToPath(import.meta.url);
const repoDefault = path.dirname(path.dirname(script));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const safeId = (s) => typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(s);
function save(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}
function read(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
export function deploymentEnv(env) {
  return Object.fromEntries(["PATH", "HOME", "USER", "SHELL", "TMPDIR", "LANG", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]
    .filter((key) => typeof env[key] === "string").map((key) => [key, env[key]]));
}
function xml(s) { return String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c])); }

export function launchWorker(job, file, { platform = process.platform, exec = execFileSync } = {}) {
  const args = [script, "worker", file];
  if (platform === "darwin") {
    const plist = path.join(job.directory, "job.plist");
    const vars = Object.entries(deploymentEnv(process.env)).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join("");
    fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>${xml(job.label)}</string><key>ProgramArguments</key><array>${[process.execPath, ...args].map((a) => `<string>${xml(a)}</string>`).join("")}</array><key>EnvironmentVariables</key><dict>${vars}</dict><key>WorkingDirectory</key><string>${xml(job.repo)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>StandardOutPath</key><string>${xml(job.log)}</string><key>StandardErrorPath</key><string>${xml(job.log)}</string></dict></plist>`, { mode: 0o600 });
    exec("launchctl", ["bootstrap", `gui/${process.getuid()}`, plist], { stdio: "pipe" });
  } else {
    try {
      exec("systemd-run", ["--user", "--collect", `--unit=${job.label}`, `--working-directory=${job.repo}`,
        ...Object.entries(deploymentEnv(process.env)).map(([k, v]) => `--setenv=${k}=${v}`), process.execPath, ...args], { stdio: "pipe" });
    } catch (error) {
      // WSL's installer-owned supervisor kills only its process group. A new
      // session is sufficient there; never use this fallback under systemd.
      if (!fs.existsSync(path.join(job.home, "node-supervisor.sh"))) throw error;
      const fd = fs.openSync(job.log, "a", 0o600);
      const child = spawn(process.execPath, args, { cwd: job.repo, env: deploymentEnv(process.env), detached: true, stdio: ["ignore", fd, fd] });
      child.unref(); fs.closeSync(fd);
    }
  }
}

export function requestDeployment({ kind = "redeploy", composition = "", repo = repoDefault, env = process.env, launch = launchWorker } = {}) {
  if (!["reload", "redeploy"].includes(kind)) throw new Error("Unknown deployment kind");
  const conversationId = env.GARRISON_CONVERSATION_ID;
  const stretchId = env.GARRISON_STRETCH_ID;
  if (!safeId(conversationId) || !safeId(stretchId)) throw new Error("Hosted deployment needs a conversation and stretch identity");
  if (env.GARRISON_INSTANCE_ID && !["prod", "node"].includes(env.GARRISON_INSTANCE_ID)) throw new Error("A sandbox cannot redeploy the live node");
  if (composition && !safeId(composition)) throw new Error("Invalid composition");
  const home = env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
  const store = openConversation(conversationId, { role: "deployment", env: { GARRISON_HOME: home } });
  if (store.currentStretch() !== stretchId) throw new Error("The requesting stretch no longer owns this conversation");
  const file = path.join(store.dir, "deployment.json");
  const previous = read(file);
  if (previous && ["queued", "running"].includes(previous.status) && Date.now() - Date.parse(previous.updatedAt) < 25 * 60_000) return previous;
  if (previous?.status === "complete" && previous.stretchId === stretchId && previous.kind === kind) return previous;
  const id = createHash("sha256").update(`${conversationId}:${stretchId}:${kind}:${previous?.updatedAt ?? ""}`).digest("hex").slice(0, 16);
  const directory = path.join(home, "deployments", id);
  fs.mkdirSync(directory, { recursive: true });
  const gatewayComposition = env.GARRISON_COMPOSITION_ID || store.tail(1, { kinds: ["stretch-started"] })[0]?.runId?.split("@")[0] || composition;
  if (!safeId(gatewayComposition)) throw new Error("Cannot identify the gateway that owns this conversation");
  const job = { id, label: `io.garrison.deploy.${id}`, kind, composition, repo, home, conversationId, stretchId,
    gatewayComposition, directory, log: path.join(directory, "deploy.log"), status: "queued", updatedAt: new Date().toISOString() };
  save(file, job);
  store.append({ kind: "note", payload: { origin: "gateway", text: "Deployment queued outside this conversation. The session will continue after the node returns." } });
  try { launch(job, file); }
  catch (err) { save(file, { ...job, status: "failed", error: String(err.message), updatedAt: new Date().toISOString() }); throw err; }
  return job;
}

export function deployedGatewayUrl(job) {
  // Instance env contains the app port, not composition-owned fitting ports.
  // Resolve the freshly spawned gateway from the runner's owner PID record.
  const composition = job.gatewayComposition || job.composition;
  if (!safeId(composition)) throw new Error("Deployment has no gateway composition");
  const dir = path.join(job.home, "gateway-pids");
  const candidates = fs.readdirSync(dir).filter((name) => name === `${composition}.json`
    || name.startsWith(`${composition}-`) && /^\d+\.json$/.test(name.slice(composition.length + 1)))
    .map((name) => read(path.join(dir, name))).filter((record) => {
      if (!Number.isInteger(record?.port) || record.port < 1 || record.port > 65535 || !Number.isInteger(record.pid) || record.pid <= 0) return false;
      try { process.kill(record.pid, 0); return true; } catch { return false; }
    });
  const ports = [...new Set(candidates.map((record) => record.port))];
  if (ports.length !== 1) throw new Error(`Expected one live gateway for ${composition}; found ${ports.length}`);
  return `http://127.0.0.1:${ports[0]}`;
}

export async function runWorker(file, { waitMs = 120_000, pollMs = 1000, run = null, resume = null } = {}) {
  const job = read(file);
  if (!job || job.status !== "queued") return;
  const store = openConversation(job.conversationId, { role: "deployment", env: { GARRISON_HOME: job.home } });
  // The model first records its handoff. The conversation loop sees the job
  // and pauses before starting another stretch. No command is replayed.
  const deadline = Date.now() + waitMs;
  while (store.currentStretch() === job.stretchId && Date.now() < deadline) {
    if (read(file)?.status !== "queued") return;
    await pause(pollMs);
  }
  if (read(file)?.status !== "queued") return;
  if (store.currentStretch() === job.stretchId) {
    save(file, { ...job, status: "failed", error: "The requesting stretch did not hand off within two minutes", updatedAt: new Date().toISOString() });
    store.append({ kind: "note", payload: { origin: "gateway", text: "Deployment cancelled because the requesting stretch did not hand off within two minutes. The node was not restarted." } });
    return;
  }
  if (store.tail(1, { kinds: ["handoff"] })[0]?.payload?.cancelled) {
    save(file, { ...job, status: "cancelled", updatedAt: new Date().toISOString() });
    return;
  }
  const workerEnv = { ...deploymentEnv(process.env), GARRISON_DEPLOYMENT_WORKER: "1" };
  save(file, { ...job, status: "running", updatedAt: new Date().toISOString() });
  const log = fs.openSync(job.log, "a", 0o600);
  let error = null;
  try {
    await (run ? run(job, workerEnv) : new Promise((resolve, reject) => {
      const child = spawn("bash", [path.join(job.repo, "scripts", `garrison-${job.kind}.sh`), ...(job.composition ? [job.composition] : [])], {
        cwd: job.repo, env: workerEnv, stdio: ["ignore", log, log], timeout: 20 * 60_000,
      });
      child.on("error", reject);
      child.on("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Deployment exited ${code ?? signal}; see ${job.log}`)));
    }));
  } catch (err) { error = String(err.message); }
  finally { fs.closeSync(log); }
  const resumeCancelled = read(file)?.resumeCancelled === true;
  save(file, { ...job, status: error ? "failed" : "complete", error, resumeCancelled, updatedAt: new Date().toISOString() });
  store.append({ kind: "note", payload: { origin: "gateway", text: error ? `Deployment failed. ${error}` : `Deployment finished. Verify the live result before reporting completion. Evidence: ${job.log}` } });
  if (error) {
    parkConversation(store, { reason: `Deployment failed. ${error}` });
  }
  if (error || resumeCancelled) return;
  try {
    if (resume) { await resume(job); return; }
    const token = fs.readFileSync(path.join(job.home, "gateway-token"), "utf8").trim();
    const res = await fetch(`${deployedGatewayUrl(job)}/conversation/kick`, { method: "POST", headers: { "content-type": "application/json", "x-garrison-token": token }, body: JSON.stringify({ conversationId: job.conversationId }), signal: AbortSignal.timeout(15_000) });
    if (!res.ok && res.status !== 409) throw new Error(`Recovery returned HTTP ${res.status}`);
  } catch (err) {
    store.append({ kind: "note", payload: { origin: "gateway", text: `The deployment job finished, but the conversation could not resume: ${err.message}. Send a message to continue.` } });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  try {
    if (process.argv[2] === "worker") await runWorker(process.argv[3]);
    else {
      const job = requestDeployment({ kind: process.argv[2], composition: process.argv[3] ?? "" });
      console.log(`Deployment ${job.id} is ${job.status}. Do not wait or run another restart. Write your handoff now, with nextSteps.next=ops (or validate). The supervised job will restart the node and resume the conversation. Log: ${job.log}`);
    }
  } catch (err) { console.error(err.message); process.exitCode = 1; }
}

#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { deploymentGuardPath, deploymentHome, deploymentDraining, localConversationActivity } from "../packages/claude-pty/src/deployment-guard.mjs";

const leasePath = "/v1/config/mesh.deployment/global";
async function stateRequest(config, method, body, rev, fetcher) {
  const res = await fetcher(`${config.url}${leasePath}`, {
    method, headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json", ...(rev !== undefined ? { "if-match": String(rev) } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000),
  });
  if (method === "GET" && res.status === 404) return { rev: 0, body: {} };
  if (!res.ok) throw new Error(`Mesh deployment lease returned HTTP ${res.status}`);
  return res.json();
}
export async function checkDeployment({ env = process.env, app, fetcher = fetch } = {}) {
  const active = localConversationActivity(env);
  if (env.GARRISON_CONVERSATION_ID || active.length) throw new Error(`Deployment deferred: this node has a working Conversation (${active.length || 1}). Continue on another node.`);
  const home = deploymentHome(env);
  // Gateway health closes the gap between durable stretch markers and quick
  // responder turns, including an admission still reading its request body.
  let records = [];
  try { records = fs.readdirSync(path.join(home, "gateway-pids")).filter((n) => n.endsWith(".json")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  for (const name of records) {
    const record = JSON.parse(fs.readFileSync(path.join(home, "gateway-pids", name), "utf8"));
    const { processExists } = await import("../packages/claude-pty/src/deployment-guard.mjs");
    if (!processExists(record.pid)) continue;
    const res = await fetcher(`http://127.0.0.1:${record.port}/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error("Cannot verify the live gateway's Conversation activity");
    const health = await res.json();
    if (health.deployment?.active > 0) throw new Error("Deployment deferred: the gateway has active Conversation work");
  }
  if (!fs.existsSync(path.join(home, "node.json"))) return { standalone: true };
  if (!app) throw new Error("Deployment needs the instance app URL");
  const res = await fetcher(`${app}/api/mesh/nodes`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error("Cannot verify another healthy mesh instance");
  const { nodes } = await res.json();
  for (const node of nodes ?? []) {
    if (node.isSelf || node.status !== "active") continue;
    const origin = node.appOrigin || (node.tailnetHost ? `https://${node.tailnetHost}` : null);
    if (!origin) continue;
    try {
      const probe = await fetcher(`${origin}/api/mesh/self`, { signal: AbortSignal.timeout(5000) });
      const peer = await probe.json();
      if (probe.ok && peer.composition?.running === true && peer.degraded === false) return { peer: node.name };
    } catch { /* try the next peer */ }
  }
  throw new Error("Deployment deferred: keep at least one other healthy mesh instance available");
}

export async function releaseDeployment({ env = process.env, fetcher = fetch, pid } = {}) {
  const file = deploymentGuardPath(env);
  let guard;
  try { guard = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return; }
  if (guard.pid !== pid) return;
  try {
    const config = JSON.parse(fs.readFileSync(path.join(deploymentHome(env), "state.json"), "utf8"));
    const current = await stateRequest(config, "GET", null, undefined, fetcher);
    if (current.body?.id === guard.id) await stateRequest(config, "PUT", { id: guard.id, node: config.node, expiresAt: 0, status: "released" }, current.rev, fetcher);
  } finally { fs.unlinkSync(file); }
}

export async function acquireDeployment({ env = process.env, app, fetcher = fetch, pid = process.ppid } = {}) {
  await checkDeployment({ env, app, fetcher });
  const file = deploymentGuardPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (deploymentDraining(env)) throw new Error("This node already has a deployment in progress");
  try { fs.unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const guard = { id: randomUUID(), pid, expiresAt: Date.now() + 30 * 60_000 };
  fs.writeFileSync(file, JSON.stringify(guard), { flag: "wx", mode: 0o600 });
  try {
    if (fs.existsSync(path.join(deploymentHome(env), "node.json"))) {
      const config = JSON.parse(fs.readFileSync(path.join(deploymentHome(env), "state.json"), "utf8"));
      const current = await stateRequest(config, "GET", null, undefined, fetcher);
      if (current.body?.expiresAt > Date.now()) throw new Error(`Deployment deferred: ${current.body.node} is already deploying`);
      await stateRequest(config, "PUT", { ...guard, node: config.node, status: "deploying" }, current.rev, fetcher);
    }
    // Admissions are closed now. Any request admitted before the guard must be
    // visible in the gateway count before we can stop services.
    return await checkDeployment({ env, app, fetcher });
  } catch (error) {
    await releaseDeployment({ env, fetcher, pid }).catch(() => {});
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, app, home, rawPid] = process.argv.slice(2);
  const options = { env: { ...process.env, GARRISON_HOME: home || process.env.GARRISON_HOME }, app, pid: Number(rawPid) || process.ppid };
  try {
    const result = mode === "release" ? await releaseDeployment(options) : mode === "acquire" ? await acquireDeployment(options) : await checkDeployment(options);
    if (result) console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 75; }
}

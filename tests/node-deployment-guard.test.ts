import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-ignore
import { localConversationActivity, deploymentDraining, deploymentGuardPath } from "../packages/claude-pty/src/deployment-guard.mjs";
// @ts-ignore
import { acquireDeployment, checkDeployment, releaseDeployment } from "../scripts/garrison-deployment-guard.mjs";

let home: string;
let env: Record<string, string>;
const put = (name: string, value: unknown) => {
  const file = path.join(home, name); mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
};
beforeEach(() => { home = mkdtempSync(path.join(os.tmpdir(), "deployment-")); env = { GARRISON_HOME: home }; });
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("Conversation-preserving deployments", () => {
  it("distinguishes live, legacy and dead stretches and pending quick replies", () => {
    put("conversations/live/.current-stretch", `stretch\n${process.pid}`);
    put("conversations/legacy/.current-stretch", "old");
    put("conversations/dead/.current-stretch", "gone\n2147483647");
    put("web-channel/threads/quick.json", { pendingInputs: [{ state: "running" }] });
    put("web-channel/threads/done.json", { pendingInputs: [] });
    expect(localConversationActivity(env).sort()).toEqual(["legacy", "live", "quick"]);
  });
  it("refuses hosted work and live markers before any network call", async () => {
    const fetcher = () => { throw new Error("unexpected network"); };
    await expect(checkDeployment({ env: { ...env, GARRISON_CONVERSATION_ID: "c" }, fetcher })).rejects.toThrow("working Conversation");
    put("conversations/live/.current-stretch", `stretch\n${process.pid}`);
    await expect(checkDeployment({ env, fetcher })).rejects.toThrow("working Conversation");
  });
  it("blocks quick gateway work even before a durable marker exists", async () => {
    put("gateway-pids/default.json", { pid: process.pid, port: 12345 });
    await expect(checkDeployment({ env, fetcher: async () => Response.json({ deployment: { active: 1 } }) })).rejects.toThrow("active Conversation work");
  });
  it("requires a live healthy peer, rather than trusting a stored ready badge", async () => {
    put("node.json", { id: "self" });
    const fetcher = async (url: string) => Response.json(url.endsWith("/nodes")
      ? { nodes: [{ name: "peer", status: "active", state: "ready", tailnetHost: "peer.test" }] }
      : { composition: { running: false }, degraded: false });
    await expect(checkDeployment({ env, app: "http://self", fetcher })).rejects.toThrow("other healthy");
  });
  it("can recover an unhealthy app while still proving another instance is live", async () => {
    put("node.json", { id: "self" }); put("state.json", { url: "http://state", node: "self", token: "test" });
    const fetcher = async (url: string) => {
      if (url.startsWith("http://self")) throw new Error("app unavailable");
      if (url === "http://state/v1/nodes") return Response.json({ nodes: [{ name: "peer", status: "active", tailnetHost: "peer.test" }] });
      return Response.json({ composition: { running: true }, degraded: false });
    };
    expect(await checkDeployment({ env, app: "http://self", fetcher })).toEqual({ peer: "peer" });
  });
  it("serializes mesh restarts with CAS and releases only its own lease", async () => {
    put("node.json", { id: "self" }); put("state.json", { url: "http://state", node: "self", token: "test" });
    let lease: any = { rev: 0, body: {} };
    const fetcher = async (url: string, init: any = {}) => {
      if (url.startsWith("http://state")) {
        if (init.method === "PUT") {
          if (Number(init.headers["if-match"]) !== lease.rev) return Response.json({}, { status: 409 });
          lease = { rev: lease.rev + 1, body: JSON.parse(init.body) };
        }
        return Response.json(lease);
      }
      return Response.json(url.endsWith("/nodes") ? { nodes: [{ name: "peer", status: "active", tailnetHost: "peer.test" }] } : { composition: { running: true }, degraded: false });
    };
    const options = { env, app: "http://self", fetcher, pid: process.pid };
    await acquireDeployment(options);
    expect(deploymentDraining(env)).toBe(true);
    await expect(acquireDeployment(options)).rejects.toThrow("already has a deployment");
    await releaseDeployment({ ...options, pid: process.pid + 1 });
    expect(deploymentDraining(env)).toBe(true);
    await releaseDeployment(options);
    expect(existsSync(deploymentGuardPath(env))).toBe(false);
    expect(lease.body.status).toBe("released");
    lease = { rev: lease.rev + 1, body: { node: "other", expiresAt: Date.now() + 60_000 } };
    await expect(acquireDeployment(options)).rejects.toThrow("other is already deploying");
    expect(existsSync(deploymentGuardPath(env))).toBe(false);
  });
  it("catches a Conversation starting between preflight and closed admissions", async () => {
    put("node.json", { id: "self" }); put("state.json", { url: "http://state", node: "self", token: "test" });
    let lease: any = { rev: 0, body: {} };
    const fetcher = async (url: string, init: any = {}) => {
      if (url.startsWith("http://state")) {
        if (init.method === "PUT") {
          lease = { rev: lease.rev + 1, body: JSON.parse(init.body) };
          if (lease.body.status === "deploying") put("conversations/race/.current-stretch", `stretch\n${process.pid}`);
        }
        return Response.json(lease);
      }
      return Response.json(url.endsWith("/nodes") ? { nodes: [{ name: "peer", status: "active", tailnetHost: "peer.test" }] } : { composition: { running: true }, degraded: false });
    };
    await expect(acquireDeployment({ env, app: "http://self", fetcher, pid: process.pid })).rejects.toThrow("working Conversation");
    expect(deploymentDraining(env)).toBe(false);
    expect(lease.body.status).toBe("released");
  });
});

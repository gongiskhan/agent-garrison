import http, { type Server } from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..");
const heartbeatScript = path.join(
  repoRoot,
  "fittings/seed/loop-heartbeat/scripts/heartbeat.mjs"
);
const briefingScript = path.join(
  repoRoot,
  "fittings/seed/morning-briefing/scripts/briefing.py"
);
const servers: Server[] = [];

async function retryingServer(statuses: number[]): Promise<{
  baseUrl: string;
  requests: () => number;
  bodies: () => string[];
}> {
  let count = 0;
  const receivedBodies: string[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      receivedBodies.push(Buffer.concat(chunks).toString("utf8"));
      const status = statuses[Math.min(count, statuses.length - 1)];
      count += 1;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(status >= 500 ? { retryable: true } : { ack: status < 300 }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests: () => count,
    bodies: () => [...receivedBodies]
  };
}

async function hangingServer(): Promise<{ url: string; requests: () => number }> {
  let count = 0;
  const server = http.createServer((request) => {
    count += 1;
    request.resume();
    // Intentionally never write a response; the producer's abort deadline must
    // end this attempt and allow the bounded retry loop to continue.
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  return { url: `http://127.0.0.1:${address.port}/jobs`, requests: () => count };
}

async function run(
  command: string,
  args: string[],
  env: Partial<NodeJS.ProcessEnv>
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ status: code ?? -1, stdout, stderr }));
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  })));
});

describe("scheduled job producer retries", () => {
  it("retries heartbeat 5xx responses but does not retry a 4xx payload failure", async () => {
    const transient = await retryingServer([503, 503, 202]);
    const recovered = await run(process.execPath, [heartbeatScript, "--once"], {
      GARRISON_GATEWAY_URL: `${transient.baseUrl}/jobs`
    });
    expect(recovered.status).toBe(0);
    expect(transient.requests()).toBe(3);
    expect(new Set(transient.bodies()).size).toBe(1);

    const invalid = await retryingServer([400, 202]);
    const rejected = await run(process.execPath, [heartbeatScript, "--once"], {
      GARRISON_GATEWAY_URL: `${invalid.baseUrl}/jobs`
    });
    expect(rejected.status).toBe(1);
    expect(invalid.requests()).toBe(1);
  });

  it("bounds hung heartbeat requests so the retry loop and daemon cadence cannot wedge", async () => {
    const hanging = await hangingServer();
    const result = await run(process.execPath, [heartbeatScript, "--once"], {
      GARRISON_GATEWAY_URL: hanging.url,
      GARRISON_JOB_POST_TIMEOUT_MS: "50"
    });
    expect(result.status).toBe(1);
    // Under host load an AbortSignal can fire before a socket reaches the test
    // server, so received requests are not a reliable count of attempted
    // fetches. The producer's structured error log is the attempt boundary.
    const attempts = result.stderr
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.kind === "heartbeat-error")
      .map((entry) => entry.attempt);
    expect(attempts).toEqual([1, 2, 3]);
    expect(hanging.requests()).toBeGreaterThanOrEqual(1);
    expect(hanging.requests()).toBeLessThanOrEqual(3);
  });

  it("retries the morning briefing after retryable gateway failures", async () => {
    const transient = await retryingServer([503, 502, 202]);
    const result = await run("python3", [briefingScript, "fire"], {
      GARRISON_GATEWAY_URL: transient.baseUrl
    });
    expect(result.status, result.stderr).toBe(0);
    expect(transient.requests()).toBe(3);
    expect(new Set(transient.bodies()).size).toBe(1);
  });
});

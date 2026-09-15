import { describe, expect, it } from "vitest";
// @ts-ignore — runtime helper is plain ESM.
import { spawnGuardedClaudeProcess } from "../fittings/seed/agent-sdk-runtime/lib/guarded-spawn.mjs";

// 2026-09-11: an MCP readiness timeout closed the SDK query while a write to the
// Claude child's stdin was still pending. The SDK's own spawn has no 'error'
// listener on that stdin, so the EPIPE became an unhandled 'error' event and
// killed the http-gateway — and with it every scheduled job for four days.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("agent-sdk guarded spawn", () => {
  it("turns an EPIPE on a child's closed stdin into a recorded error, not a crash", async () => {
    const stdinErrors: NodeJS.ErrnoException[] = [];
    // The child closes its end of the pipe and stays alive: every write after
    // that is EPIPE — the exact `Emitted 'error' event on Socket instance`
    // stack that killed the gateway, and a crash of this test process without
    // the listener.
    const child = spawnGuardedClaudeProcess(
      {
        command: process.execPath,
        args: ["-e", "require('fs').closeSync(0); setTimeout(() => {}, 5000)"],
        env: { ...process.env } as Record<string, string>
      },
      { onStdinError: (error: NodeJS.ErrnoException) => stdinErrors.push(error) }
    );
    try {
      await sleep(500);
      const chunk = "x".repeat(256 * 1024);
      for (let i = 0; i < 8; i += 1) child.stdin.write(chunk);
      await sleep(300);
      expect(stdinErrors.length).toBeGreaterThan(0);
      expect(stdinErrors[0].code).toBe("EPIPE");
    } finally {
      child.kill();
    }
  });

  it("mirrors the SDK's default stdio and only pipes stderr when someone reads it", () => {
    const calls: any[] = [];
    const fakeChild = () => ({
      stdin: { on: () => {} },
      stderr: { on: (_event: string, fn: (chunk: Buffer) => void) => fn(Buffer.from("warn")) },
    });
    const spawnImpl = (command: string, args: string[], options: any) => {
      calls.push({ command, args, options });
      return fakeChild();
    };
    spawnGuardedClaudeProcess({ command: "claude", args: ["-p"], cwd: "/tmp", env: {} }, { spawnImpl });
    expect(calls[0].options.stdio).toEqual(["pipe", "pipe", "ignore"]);

    const seen: string[] = [];
    spawnGuardedClaudeProcess(
      { command: "claude", args: ["-p"], cwd: "/tmp", env: {} },
      { spawnImpl, stderr: (text: string) => seen.push(text) }
    );
    expect(calls[1].options.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(calls[1].options.cwd).toBe("/tmp");
    expect(seen).toEqual(["warn"]);
  });
});

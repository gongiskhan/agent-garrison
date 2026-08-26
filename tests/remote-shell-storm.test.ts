// The render-storm detector, pinned at its two destructive edges.
//
// The recovery this guards ends in `tmux respawn-pane -k`: it KILLS the remote
// agent and types a resume command in its place. That makes two ordinary-looking
// bugs severe rather than cosmetic, and both were shipped once:
//
//   - a meter that compares a byte TOTAL against a per-second threshold, and
//     back-dates "hot since" to the start of the bucket, fires on a quiet
//     trickle that follows a gap - so a working agent is killed for being idle;
//   - a recovery that never checks whether the resume landed reports success
//     after leaving the pane at a bare shell with the conversation gone.
//
// Both are driven through the real attach path (bytes arriving on the injected
// PTY, exactly as the live stream delivers them), so neither can come back
// without a red test.

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-ignore - dependency-free fitting JavaScript
import { loadTransports } from "../fittings/seed/remote-shell-runtime/lib/transports.mjs";
// @ts-ignore - dependency-free fitting JavaScript
import { SessionManager } from "../fittings/seed/remote-shell-runtime/lib/sessions.mjs";

let tmpHome: string;
let priorHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(os.tmpdir(), "rsh-storm-"));
  priorHome = process.env.GARRISON_HOME;
  process.env.GARRISON_HOME = tmpHome;
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.GARRISON_HOME;
  else process.env.GARRISON_HOME = priorHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

type ExecResult = { code: number | null; stdout: string; stderr: string };
type Harness = {
  manager: any;
  session: any;
  /** Deliver bytes the way the attach client does. */
  feed: (n: number) => void;
  commands: string[];
  notifications: any[];
};

async function harness(
  exec: (cmd: string) => ExecResult,
  { resumeCommand = "cursor-agent --force resume" } = {}
): Promise<Harness> {
  const commands: string[] = [];
  const notifications: any[] = [];
  let onData: ((s: string) => void) | null = null;

  const env = {
    GARRISON_REMOTESHELLRUNTIME_TRANSPORTS: JSON.stringify({
      fake: {
        ssh: { host: "127.0.0.1", port: 9, user: "nobody" },
        tmuxSession: "fake",
        agentCommand: "cursor-agent",
        agentResumeCommand: resumeCommand
      }
    })
  } as unknown as NodeJS.ProcessEnv;

  const manager = new SessionManager({
    tunnels: { ensure: async () => ({ ok: true }), noteTraffic() {}, markSuspect() {} },
    transports: await loadTransports(env),
    notify: async (p: unknown) => { notifications.push(p); },
    exec: async (_t: unknown, cmd: string) => { commands.push(cmd); return exec(cmd); },
    ptySpawn: () => ({
      onData(cb: (s: string) => void) { onData = cb; },
      onExit() {},
      write() {}, resize() {}, kill() {}
    })
  });

  mkdirSync(path.join(tmpHome, "remote-shell"), { recursive: true });
  writeFileSync(
    path.join(tmpHome, "remote-shell", "sessions.json"),
    JSON.stringify({
      sessions: [{
        id: "s1", transport: "fake", tmuxSession: "fake",
        label: "Fake", createdAt: new Date().toISOString(), state: "idle", lastEventAt: null
      }]
    })
  );
  expect(await manager.restore()).toBe(1);
  const session = manager.get("s1");
  manager.ensureAttached(session);
  expect(onData).toBeTypeOf("function");

  return {
    manager,
    session,
    feed: (n: number) => onData!("x".repeat(n)),
    commands,
    notifications
  };
}

const respawned = (commands: string[]) => commands.some((c) => c.includes("respawn-pane"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the storm meter measures a rate, not a total", () => {
  it("does not kill the agent for a trickle that follows a long idle gap", async () => {
    const h = await harness(() => ({ code: 0, stdout: "cursor-agent\n", stderr: "" }));

    // 300KB opens the bucket - a normal burst, a screenful of diff - and then
    // the pane goes quiet for longer than the sustain window, which is exactly
    // what an agent waiting on the user looks like. A byte closes the bucket at
    // the far end.
    //
    // A bucket is only closed by the NEXT chunk, so this one is ~9s long and
    // holds 300KB: as a TOTAL that clears the 250KB threshold, while the RATE it
    // actually represents is ~33KB/s, an order of magnitude below repaint level.
    // The old meter read the total AND dated "hot since" from the start of the
    // bucket, so this single sample satisfied the whole 8s sustain at once and
    // the working agent was killed for being idle.
    h.feed(300_000);
    await sleep(9_000);
    h.feed(1);
    await sleep(300);

    expect(respawned(h.commands)).toBe(false);
    expect(h.session.stormMeter?.localHotSince ?? 0).toBe(0);
  }, 20_000);
});

describe("a recovery that could not resume never claims it did", () => {
  it("warns that the pane is at a shell instead of reporting success", async () => {
    // Genuine repaint-level traffic; the pane is running the agent and the
    // respawn lands, but the resume - the only step that brings the agent back -
    // is lost, which is the exact shape of a link dying mid-recovery.
    const h = await harness((cmd) => {
      if (cmd.includes("pane_current_command")) return { code: 0, stdout: "cursor-agent\n", stderr: "" };
      if (cmd.includes("respawn-pane")) return { code: 0, stdout: "", stderr: "" };
      if (cmd.includes("send-keys")) return { code: 255, stdout: "", stderr: "closed by remote host" };
      return { code: 0, stdout: "", stderr: "" };
    });

    // 400KB every 250ms = 1.6MB/s, sustained past the 8s window.
    for (let i = 0; i < 40; i++) {
      h.feed(400_000);
      await sleep(250);
    }
    await sleep(1_500);

    expect(respawned(h.commands)).toBe(true);
    expect(h.commands.some((c) => c.includes("send-keys") && c.includes("resume"))).toBe(true);

    // The claim must match reality: a hand-needed notice, never "chat resumed".
    const titles = h.notifications.map((n) => String(n?.title ?? ""));
    expect(titles.some((t) => /needs a hand/i.test(t))).toBe(true);
    expect(titles.some((t) => /recovered/i.test(t))).toBe(false);

    // A failed recovery takes the short retry, not the five-minute cooldown that
    // would suppress detection having fixed nothing.
    const untilCooldownEnds = (h.session.stormMeter?.cooldownUntil ?? 0) - Date.now();
    expect(untilCooldownEnds).toBeLessThan(60_000);
  }, 30_000);
});

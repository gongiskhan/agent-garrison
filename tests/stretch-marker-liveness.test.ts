// The .current-stretch marker is the conversation's write guard - and until
// now it outlived its writer. A gateway restart (or a crash before the
// fail-loudly work) left the marker behind, currentStretch() reported the
// dead stretch as running, and the message lane deferred to a runner that
// would never read: the conversation went DEAF - the live failure that
// swallowed a user's "continue" for seven hours on card 01M1BFEN. The marker
// now carries its writer's pid; a marker whose writer is gone is crash
// residue, swept on read.
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-ignore — pure .mjs (single-line on purpose: @ts-ignore only covers the next line)
import { openConversation } from "../packages/claude-pty/src/conversation-store.mjs";

let tmp: string;
let env: Record<string, string>;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "stretch-marker-"));
  env = { GARRISON_HOME: tmp };
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const CONV = "01M1MARKERLIVENESS00000001";

function markerPath() {
  return path.join(tmp, "conversations", CONV, ".current-stretch");
}

describe("stretch marker liveness", () => {
  it("claim writes the stretch id AND the claiming pid", () => {
    const store = openConversation(CONV, { role: "test", env });
    store.init({ title: "t" });
    expect(store.claimStretch("st_1")).toBe(true);
    const [id, pid] = readFileSync(markerPath(), "utf8").split("\n");
    expect(id).toBe("st_1");
    expect(Number(pid)).toBe(process.pid);
    expect(store.currentStretch()).toBe("st_1");
    expect(store.releaseStretch("st_1")).toBe(true);
    expect(store.currentStretch()).toBeNull();
  });

  it("a marker from a dead process is swept on read", () => {
    const store = openConversation(CONV, { role: "test", env });
    store.init({ title: "t" });
    // A pid that certainly exited: a child we already reaped.
    const dead = spawnSync("true").pid!;
    writeFileSync(markerPath(), `st_ghost\n${dead}`);
    expect(store.currentStretch()).toBeNull();
    expect(existsSync(markerPath())).toBe(false);
    // And the conversation is claimable again - not deaf.
    expect(store.claimStretch("st_2")).toBe(true);
  });

  it("an old-format marker (no pid) is trusted, not swept", () => {
    const store = openConversation(CONV, { role: "test", env });
    store.init({ title: "t" });
    writeFileSync(markerPath(), "st_legacy");
    expect(store.currentStretch()).toBe("st_legacy");
    expect(existsSync(markerPath())).toBe(true);
    expect(store.releaseStretch("st_legacy")).toBe(true);
  });

  it("release matches on the id line only, never the raw file", () => {
    const store = openConversation(CONV, { role: "test", env });
    store.init({ title: "t" });
    store.claimStretch("st_3");
    expect(store.releaseStretch("st_other")).toBe(false);
    expect(store.currentStretch()).toBe("st_3");
    expect(store.releaseStretch("st_3")).toBe(true);
  });
});

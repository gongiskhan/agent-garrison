import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM .mjs sibling, no .d.ts; vitest resolves it
import { readWebChannelStatus } from "../fittings/seed/kanban-loop/scripts/server.mjs";

// /board/runtime discovers the live web channel by scanning the status-file
// directory (~/.garrison/ui-fittings) for `web-channel*` entries. These tests
// drive the discovery helper directly with a sandboxed dir so the assertions
// don't depend on whatever the host machine has installed.

interface ChannelStatus {
  id: string | null;
  url: string | null;
}

let tmp: string;

function writeStatus(name: string, body: Record<string, unknown>) {
  writeFileSync(path.join(tmp, name), JSON.stringify(body, null, 2), "utf8");
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "kanban-runtime-"));
  mkdirSync(tmp, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("/board/runtime — readWebChannelStatus (V1d channel discovery)", () => {
  it("returns null id when no web channel status file is present", async () => {
    // Other fittings present must not be misread as a channel.
    writeStatus("dev-env.json", { fittingId: "dev-env", url: "http://127.0.0.1:7086", pid: 1 });
    writeStatus("monitor-default.json", { fittingId: "monitor-default", url: "http://127.0.0.1:7077", pid: 2 });
    const got = (await readWebChannelStatus(tmp)) as ChannelStatus;
    expect(got).toEqual({ id: null, url: null });
  });

  it("returns the channel id + url when one web channel is installed", async () => {
    writeStatus("web-channel-default.json", {
      fittingId: "web-channel-default",
      url: "http://127.0.0.1:7083",
      pid: 12345,
      startedAt: "2026-06-25T00:00:00.000Z"
    });
    const got = (await readWebChannelStatus(tmp)) as ChannelStatus;
    expect(got).toEqual({ id: "web-channel-default", url: "http://127.0.0.1:7083" });
  });

  it("prefers the conventional `web-channel-default.json` when multiple channels exist", async () => {
    // Sort would surface the alphabetically-first file otherwise — explicitly
    // preferring the seed name keeps the test surface (and the UI choice)
    // stable when a composition adds a second channel.
    writeStatus("web-channel-alpha.json", { fittingId: "web-channel-alpha", url: "http://127.0.0.1:7100", pid: 1 });
    writeStatus("web-channel-default.json", { fittingId: "web-channel-default", url: "http://127.0.0.1:7083", pid: 2 });
    const got = (await readWebChannelStatus(tmp)) as ChannelStatus;
    expect(got.id).toBe("web-channel-default");
    expect(got.url).toBe("http://127.0.0.1:7083");
  });

  it("falls through to the next file when one is malformed JSON", async () => {
    writeFileSync(path.join(tmp, "web-channel-bad.json"), "{ not valid json", "utf8");
    writeStatus("web-channel-default.json", { fittingId: "web-channel-default", url: "http://127.0.0.1:7083", pid: 1 });
    const got = (await readWebChannelStatus(tmp)) as ChannelStatus;
    expect(got.id).toBe("web-channel-default");
  });

  it("does not match unrelated fitting ids that happen to live in the same dir", async () => {
    // A status file whose name starts with web-channel but whose fittingId
    // disagrees must not be returned; we trust the file body, not the name.
    writeStatus("web-channel-faux.json", { fittingId: "monitor-default", url: "http://x", pid: 1 });
    const got = (await readWebChannelStatus(tmp)) as ChannelStatus;
    // The filename starts with web-channel so the helper inspects it; the body
    // says monitor-default, which the helper does accept (today's implementation
    // requires the fittingId to start with "web-channel" too). This pins the
    // safer behavior.
    expect(got.id).toEqual(null);
  });

  it("returns {id: null, url: null} when the directory itself is missing", async () => {
    rmSync(tmp, { recursive: true, force: true });
    const got = (await readWebChannelStatus(tmp)) as ChannelStatus;
    expect(got).toEqual({ id: null, url: null });
  });
});

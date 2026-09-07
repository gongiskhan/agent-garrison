import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { CATALOG, runAction } from "../fittings/seed/spotify/scripts/connector.mjs";

// Every transport is synthetic. No real credentials, login, playback or devices.
const ENV = { SPOTIFY_ACCESS_TOKEN: "spotify-test-token" };
const script = path.resolve("fittings/seed/spotify/scripts/connector.mjs");
type FetchOptions = RequestInit & { headers?: Record<string, string> };
type Reply = { status?: number; body?: unknown; raw?: string };
function transport(...replies: Reply[]) {
  return vi.fn(async (_url: string, _opts?: unknown) => {
    const reply = replies.shift();
    if (!reply) throw new Error("unexpected HTTP request");
    const status = reply.status ?? 200;
    return {
      ok: status >= 200 && status < 300, status,
      json: async () => reply.body ?? {},
      text: async () => reply.raw ?? JSON.stringify(reply.body ?? {})
    };
  });
}
function request(fetchImpl: ReturnType<typeof transport>, index = 0) {
  const [url, opts] = fetchImpl.mock.calls[index];
  return { url: new URL(url), opts: opts as FetchOptions };
}
const homes: string[] = [];
function home() {
  const dir = mkdtempSync(path.join(tmpdir(), "spotify-connector-"));
  homes.push(dir);
  return dir;
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Spotify connector", () => {
  it("keeps the CLI and manifest catalogs aligned and verifies without credentials or network", () => {
    const manifest = YAML.parse(readFileSync(path.resolve("fittings/seed/spotify/apm.yml"), "utf8"));
    const actions = (items: typeof CATALOG.actions) => items.map(({ name, args, mutates }) => ({ name, args: args ?? [], mutates }));
    expect(actions(CATALOG.actions)).toEqual(actions(manifest["x-garrison"].connector.actions));
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, HOME: home(), GARRISON_HOME: home() };
    const probe = execFileSync(process.execPath, ["--import", "data:text/javascript,globalThis.fetch=()=>{throw Error('probe attempted network')}", script, "--probe"], { env, encoding: "utf8", timeout: 5000 });
    expect(probe.trim()).toBe("connectorOk");
    expect(JSON.parse(execFileSync(process.execPath, [script, "catalog"], { env, encoding: "utf8", timeout: 5000 }))).toEqual(CATALOG);
  });

  it("does not consult ambient live auth when an explicit isolated env was supplied", async () => {
    const liveHome = home();
    writeFileSync(path.join(liveHome, "internal-token"), "ambient-capability");
    vi.stubEnv("GARRISON_HOME", liveHome);
    vi.stubEnv("GARRISON_BASE_URL", "http://ambient.invalid");
    const fetchImpl = transport({ body: { env: ENV } }, { status: 204 });
    await expect(runAction({ action: "current", env: {}, fetchImpl })).rejects.toMatchObject({ awaiting_connector: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("resolves auth only from the supplied instance and carries its capability token", async () => {
    const isolatedHome = home();
    writeFileSync(path.join(isolatedHome, "internal-token"), "isolated-capability");
    const fetchImpl = transport({ body: { env: ENV } }, { status: 204 });
    await expect(runAction({ action: "current", env: { GARRISON_HOME: isolatedHome, GARRISON_APP_URL: "http://instance.invalid/" }, fetchImpl })).resolves.toEqual({ is_playing: false });
    expect(request(fetchImpl).url.href).toBe("http://instance.invalid/api/connectors/spotify/auth-env");
    expect(request(fetchImpl).opts.headers?.["x-garrison-internal"]).toBe("isolated-capability");
    expect(request(fetchImpl, 1).opts.headers?.Authorization).toBe("Bearer spotify-test-token");
  });

  it("reports an unconnected grant without issuing Spotify requests", async () => {
    const isolatedHome = home();
    writeFileSync(path.join(isolatedHome, "internal-token"), "isolated-capability");
    const fetchImpl = transport({ status: 409 });
    await expect(runAction({ action: "current", env: { GARRISON_HOME: isolatedHome, GARRISON_APP_URL: "http://instance.invalid" }, fetchImpl })).rejects.toMatchObject({ awaiting_connector: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reads current playback metadata and handles the empty 204 state", async () => {
    const fetchImpl = transport({ body: { is_playing: true, item: { name: "Fixture track", artists: [{ name: "Fixture artist" }], album: { name: "Fixture album", images: [{ url: "https://images.invalid/cover" }] }, duration_ms: 5000 }, device: { name: "Fixture device" }, progress_ms: 1000 } });
    await expect(runAction({ action: "current", env: ENV, fetchImpl })).resolves.toMatchObject({ is_playing: true, track: "Fixture track", artist: "Fixture artist", device: "Fixture device", progress_ms: 1000 });
    await expect(runAction({ action: "current", env: ENV, fetchImpl: transport({ status: 204 }) })).resolves.toEqual({ is_playing: false });
  });

  it.each(["track", "artist", "album", "playlist"])("searches %s with the user token country instead of undocumented market=from_token", async (type) => {
    const fetchImpl = transport({ body: { [`${type}s`]: { items: [null, { name: "Fixture", uri: `spotify:${type}:fixture` }] } } });
    await expect(runAction({ action: "search", args: { query: "a & b", type }, env: ENV, fetchImpl })).resolves.toEqual([{ name: "Fixture", uri: `spotify:${type}:fixture` }]);
    expect(request(fetchImpl).url.searchParams.get("q")).toBe("a & b");
    expect(request(fetchImpl).url.searchParams.get("market")).toBeNull();
  });

  it("encodes a configured country consistently for search and play", async () => {
    const fetchImpl = transport({ body: { tracks: { items: [] } } });
    await runAction({ action: "search", args: { query: "Fixture" }, env: { ...ENV, SPOTIFY_MARKET: "pt" }, fetchImpl });
    expect(request(fetchImpl).url.searchParams.get("market")).toBe("PT");
  });

  it("plays a search track on the current active device without choosing an arbitrary inactive device", async () => {
    const fetchImpl = transport({ body: { tracks: { items: [{ uri: "spotify:track:fixture", name: "Fixture", artists: [] }] } } }, { status: 204 });
    await expect(runAction({ action: "play", args: { query: "Fixture" }, env: ENV, fetchImpl })).resolves.toMatchObject({ device: "active" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(request(fetchImpl, 1).url.pathname).toBe("/v1/me/player/play");
    expect(request(fetchImpl, 1).url.searchParams.has("device_id")).toBe(false);
    expect(JSON.parse(String(request(fetchImpl, 1).opts.body))).toEqual({ uris: ["spotify:track:fixture"] });
  });

  it("uses the artist context when search returns no track", async () => {
    const fetchImpl = transport({ body: { artists: { items: [{ uri: "spotify:artist:fixture", name: "Fixture artist" }] } } }, { status: 204 });
    await runAction({ action: "play", args: { query: "Fixture artist" }, env: ENV, fetchImpl });
    expect(JSON.parse(String(request(fetchImpl, 1).opts.body))).toEqual({ context_uri: "spotify:artist:fixture" });
  });

  it.each(["pause", "resume", "next", "previous", "volume", "play_uri"])("honors a configured device for %s", async (action) => {
    const fetchImpl = transport({ body: { devices: [{ id: "other", name: "Phone speaker", is_active: true }, { id: "preferred", name: "Phone" }] } }, { status: 204 });
    await runAction({ action, args: { percent: 40, uri: "spotify:track:fixture" }, env: { ...ENV, SPOTIFY_DEVICE_NAME: "phone" }, fetchImpl });
    expect(request(fetchImpl, 1).url.searchParams.get("device_id")).toBe("preferred");
  });

  it.each([
    ["unavailable", [{ id: "other", name: "Elsewhere", is_active: true }]],
    ["ambiguous", [{ id: "one", name: "Phone one" }, { id: "two", name: "Phone two" }]],
    ["restricted", [{ id: "one", name: "Phone", is_restricted: true }]],
    ["without an id", [{ id: null, name: "Phone" }]]
  ])("refuses an %s configured device without sending a playback command", async (_kind, devices) => {
    const fetchImpl = transport({ body: { devices } }, { status: 204 });
    await expect(runAction({ action: "resume", env: { ...ENV, SPOTIFY_DEVICE_NAME: "phone" }, fetchImpl })).rejects.toThrow(/device/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retains auth failures during device discovery instead of trying a playback write", async () => {
    const fetchImpl = transport({ status: 401 }, { status: 204 });
    await expect(runAction({ action: "resume", env: { ...ENV, SPOTIFY_DEVICE_NAME: "phone" }, fetchImpl })).rejects.toMatchObject({ awaiting_connector: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(["spotify:track:fixture", "spotify:album:fixture", "spotify:artist:fixture", "spotify:playlist:fixture"])("maps %s to the documented playback body", async (uri) => {
    const fetchImpl = transport({ status: 204 });
    await runAction({ action: "play_uri", args: { uri }, env: ENV, fetchImpl });
    expect(JSON.parse(String(request(fetchImpl).opts.body))).toEqual(uri.includes(":track:") ? { uris: [uri] } : { context_uri: uri });
  });

  it("transfers to the explicit device id using the Spotify body contract", async () => {
    const fetchImpl = transport({ status: 204 });
    await runAction({ action: "transfer", args: { device_id: "fixture-device" }, env: ENV, fetchImpl });
    expect(request(fetchImpl).url.pathname).toBe("/v1/me/player");
    expect(JSON.parse(String(request(fetchImpl).opts.body))).toEqual({ device_ids: ["fixture-device"], play: true });
  });

  it("lists unavailable and restricted devices honestly without attempting control", async () => {
    const fetchImpl = transport({ body: { devices: [null, { id: null, name: "Restricted", is_active: false, is_restricted: true }] } });
    await expect(runAction({ action: "devices", env: ENV, fetchImpl })).resolves.toEqual([{ id: null, name: "Restricted", is_active: false, is_restricted: true }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("honors the runner-projected device name and rounds a valid volume", async () => {
    const fetchImpl = transport({ body: { devices: [{ id: "target", name: "Fixture" }] } }, { status: 204 });
    await runAction({ action: "volume", args: { percent: "42.4" }, env: { ...ENV, GARRISON_SPOTIFY_DEVICE_NAME: "Fixture" }, fetchImpl });
    expect(request(fetchImpl, 1).url.searchParams.get("volume_percent")).toBe("42");
    expect(request(fetchImpl, 1).url.searchParams.get("device_id")).toBe("target");
  });

  it.each([null, "", true, -1, 101, "Infinity", "not-a-number"])("rejects invalid volume %s before a playback request", async (percent) => {
    const fetchImpl = transport({ body: {} }, { status: 204 });
    await expect(runAction({ action: "volume", args: { percent }, env: ENV, fetchImpl })).rejects.toThrow(/percent/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects malformed playback URIs and unknown actions without an HTTP request", async () => {
    const fetchImpl = transport({ status: 204 });
    await expect(runAction({ action: "play_uri", args: { uri: "https://example.invalid" }, env: ENV, fetchImpl })).rejects.toThrow(/uri/i);
    await expect(runAction({ action: "missing", env: {}, fetchImpl })).rejects.toThrow(/unknown action/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 429, 500])("reports HTTP %s without echoing provider error bodies or credentials", async (status) => {
    const error = await runAction({ action: "pause", env: ENV, fetchImpl: transport({ status, raw: "provider-body spotify-test-token" }) }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toMatch(/provider-body|spotify-test-token/);
    if (status === 401) expect(error).toMatchObject({ awaiting_connector: true });
  });

  it("does not claim idle playback when a successful read contains malformed JSON", async () => {
    await expect(runAction({ action: "current", env: ENV, fetchImpl: transport({ raw: "not json" }) })).rejects.toThrow(/response/i);
  });

  it("bounds auth-body reads and never uses a token arriving after the deadline", async () => {
    vi.useFakeTimers();
    const isolatedHome = home();
    writeFileSync(path.join(isolatedHome, "internal-token"), "isolated-capability");
    let resolveAuth!: (value: unknown) => void;
    const body = new Promise<unknown>((resolve) => { resolveAuth = resolve; });
    let signal: AbortSignal | null | undefined;
    const fetchImpl = vi.fn(async (_url: string, opts?: unknown) => {
      signal = (opts as RequestInit).signal;
      return { ok: true, status: 200, json: () => body, text: async () => "" };
    });
    const outcome = runAction({ action: "pause", env: { GARRISON_HOME: isolatedHome, GARRISON_APP_URL: "http://instance.invalid" }, fetchImpl }).catch((err: Error) => err);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await Promise.race([outcome, Promise.resolve("still pending")])).toMatchObject({ message: expect.stringMatching(/timed out/) });
    expect(signal?.aborted).toBe(true);
    resolveAuth({ env: ENV });
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(["request", "body"])("bounds a stalled %s and aborts its transport", async (where) => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const never = new Promise<never>(() => {});
    const fetchImpl = vi.fn(async (_url: string, opts?: unknown) => {
      signal = (opts as RequestInit).signal;
      if (where === "request") return never;
      return { ok: true, status: 200, json: () => never, text: () => never };
    });
    const outcome = runAction({ action: "current", env: ENV, fetchImpl }).catch((err: Error) => err);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await Promise.race([outcome, Promise.resolve("still pending")])).toMatchObject({ message: expect.stringMatching(/timed out/) });
    expect(signal?.aborted).toBe(true);
  });

  it("never starts a delayed playback write after the action deadline", async () => {
    vi.useFakeTimers();
    let resolveBody!: (value: string) => void;
    const body = new Promise<string>((resolve) => { resolveBody = resolve; });
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: () => body }));
    const outcome = runAction({ action: "play", args: { query: "Fixture" }, env: ENV, fetchImpl }).catch((err: Error) => err);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await Promise.race([outcome, Promise.resolve("still pending")])).toBeInstanceOf(Error);
    resolveBody(JSON.stringify({ tracks: { items: [{ name: "Fixture", uri: "spotify:track:fixture" }] } }));
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

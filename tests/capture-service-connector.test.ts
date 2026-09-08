// The voice connector (D26): a client of the RUNNING capture service, not a
// second Deepgram/ElevenLabs client. It finds the service through the status
// file the server writes, presents CAPTURE_TOKEN as the Bearer, and speaks the
// uniform connector contract (--probe / catalog / call) automations use.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CATALOG, runAction } from "../fittings/seed/capture-service/scripts/connector.mjs";

const CONNECTOR = path.resolve(__dirname, "../fittings/seed/capture-service/scripts/connector.mjs");
// The child inherits the shell env but never a CAPTURE_TOKEN a live Garrison
// shell may carry: the probe must succeed keyless and the awaiting_connector
// case must see none.
const CLI_ENV: NodeJS.ProcessEnv = { ...process.env, CAPTURE_TOKEN: "" };
const TOKEN = "capture-test-token";
const MP3 = Buffer.from("ID3fake-mp3");

type Call = { path: string; method: string; headers: http.IncomingHttpHeaders; body: Buffer };

function readAll(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

describe("capture-service voice connector", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "capture-connector-"));
  const statusFile = path.join(home, "ui-fittings", "capture-service.json");
  const calls: Call[] = [];
  let stub: http.Server;
  let base: string;

  beforeAll(async () => {
    // A stub of the running service: the two lanes with their real shapes.
    stub = http.createServer(async (req, res) => {
      const body = await readAll(req);
      calls.push({ path: req.url ?? "", method: req.method ?? "", headers: req.headers, body });
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "bad token" }));
        return;
      }
      if (req.url?.startsWith("/stt")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ transcript: "buy strawberries", confidence: 0.91, language: "en", model: "nova-3" }));
        return;
      }
      if (req.url === "/tts") {
        const parsed = JSON.parse(body.toString());
        if (parsed.text.length > 600) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "text over 600 characters; chunk it" }));
          return;
        }
        res.writeHead(200, { "content-type": "audio/mpeg", "x-clip-id": "abc123", "x-voice-backend": "deepgram" });
        res.end(MP3);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", () => resolve()));
    const port = (stub.address() as { port: number }).port;
    base = `http://127.0.0.1:${port}`;
    mkdirSync(path.dirname(statusFile), { recursive: true });
    writeFileSync(statusFile, JSON.stringify({ fittingId: "capture-service", port, url: base, pid: process.pid }));
  });
  afterAll(() => {
    stub?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("probes without secrets or network, and prints the catalog", () => {
    const probe = execFileSync("node", [CONNECTOR, "--probe"], { env: CLI_ENV }).toString().trim();
    expect(probe).toBe("connectorOk");
    const catalog = JSON.parse(execFileSync("node", [CONNECTOR, "catalog"], { env: CLI_ENV }).toString());
    expect(catalog).toEqual(CATALOG);
    expect(catalog.service).toBe("voice");
    expect(catalog.auth).toBe("api_key");
    expect(catalog.actions.map((a: { name: string }) => a.name)).toEqual(["transcribe", "synthesize"]);
    expect(catalog.actions.every((a: { mutates: boolean }) => a.mutates === false)).toBe(true);
    expect(catalog.actions[0].args).toEqual(["audio_base64", "path", "mime_type", "language"]);
    expect(catalog.actions[1].args).toEqual(["text", "inline"]);
  });

  it("transcribes a base64 clip through the running service's /stt", async () => {
    calls.length = 0;
    const audio = Buffer.from("fake-webm-bytes");
    const result = await runAction({
      action: "transcribe",
      args: { audio_base64: audio.toString("base64"), mime_type: "audio/webm", language: "en" },
      env: { GARRISON_HOME: home, CAPTURE_TOKEN: TOKEN }
    });
    expect(result).toEqual({ transcript: "buy strawberries", confidence: 0.91, language: "en", model: "nova-3" });
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/stt?language=en");
    expect(calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0].headers["content-type"]).toBe("audio/webm");
    expect(calls[0].body.equals(audio)).toBe(true);
  });

  it("transcribes from a local path when no base64 is given", async () => {
    calls.length = 0;
    const file = path.join(home, "clip.m4a");
    writeFileSync(file, Buffer.from("m4a-bytes"));
    const result = await runAction({
      action: "transcribe",
      args: { path: file, mime_type: "audio/m4a" },
      env: { GARRISON_HOME: home, CAPTURE_TOKEN: TOKEN }
    });
    expect(result.transcript).toBe("buy strawberries");
    expect(calls[0].path).toBe("/stt");
    expect(calls[0].headers["content-type"]).toBe("audio/m4a");
    expect(calls[0].body.toString()).toBe("m4a-bytes");
  });

  it("synthesizes through /tts and returns the clip by id and path, bytes only on request", async () => {
    calls.length = 0;
    const result = await runAction({
      action: "synthesize",
      args: { text: "Card created." },
      env: { GARRISON_HOME: home, CAPTURE_TOKEN: TOKEN }
    });
    // No audio in the default result: the engine persists every result into
    // the run record, so the clip is referenced, not carried.
    expect(result).toEqual({
      clip_id: "abc123",
      clip_path: "/speak/abc123.mp3",
      mime: "audio/mpeg",
      bytes: MP3.length,
      backend: "deepgram"
    });
    expect(calls[0].path).toBe("/tts");
    expect(JSON.parse(calls[0].body.toString())).toEqual({ text: "Card created.", format: "mp3" });

    const inline = await runAction({
      action: "synthesize",
      args: { text: "Card created.", inline: true },
      env: { GARRISON_HOME: home, CAPTURE_TOKEN: TOKEN }
    });
    expect(inline).toMatchObject({ clip_id: "abc123", audio_base64: MP3.toString("base64") });
  });

  it("surfaces the service's refusal as an error carrying its status and message", async () => {
    await expect(
      runAction({ action: "synthesize", args: { text: "a".repeat(601) }, env: { GARRISON_HOME: home, CAPTURE_TOKEN: TOKEN } })
    ).rejects.toThrow(/\/tts 400: text over 600 characters/);
    await expect(
      runAction({ action: "synthesize", args: { text: "hi" }, env: { GARRISON_HOME: home, CAPTURE_TOKEN: "wrong" } })
    ).rejects.toThrow(/\/tts 401: bad token/);
  });

  it("reports awaiting_connector without CAPTURE_TOKEN, before touching the network", async () => {
    calls.length = 0;
    let caught: (Error & { awaiting_connector?: boolean }) | null = null;
    try {
      await runAction({ action: "synthesize", args: { text: "hi" }, env: { GARRISON_HOME: home } });
    } catch (err) {
      caught = err as Error & { awaiting_connector?: boolean };
    }
    expect(caught?.awaiting_connector).toBe(true);
    expect(caught?.message).toContain("CAPTURE_TOKEN");
    expect(calls).toHaveLength(0);

    // The CLI shape an automation reads: exit 1, JSON on stdout.
    const proc = spawnSync("node", [CONNECTOR, "call", "synthesize", JSON.stringify({ text: "hi" })], {
      env: { ...CLI_ENV, GARRISON_HOME: home },
      encoding: "utf8"
    });
    expect(proc.status).toBe(1);
    expect(JSON.parse(proc.stdout)).toMatchObject({ ok: false, awaiting_connector: true });
  });

  it("names the missing service (not a missing key) when the status file is absent", async () => {
    await expect(
      runAction({
        action: "synthesize",
        args: { text: "hi" },
        env: { GARRISON_HOME: path.join(home, "nowhere"), CAPTURE_TOKEN: TOKEN }
      })
    ).rejects.toThrow(/capture-service is not running/);
  });

  it("rejects an unknown action and a transcribe with no audio", async () => {
    await expect(runAction({ action: "translate", args: {}, env: { GARRISON_HOME: home, CAPTURE_TOKEN: TOKEN } })).rejects.toThrow(
      /unknown action/
    );
    await expect(runAction({ action: "transcribe", args: {}, env: { GARRISON_HOME: home, CAPTURE_TOKEN: TOKEN } })).rejects.toThrow(
      /audio_base64 or path/
    );
  });
});

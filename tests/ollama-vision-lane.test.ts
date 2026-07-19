// Local-vision lane (Drill Evidence V2, S2): a routed ollama-local target
// receives image-carrying turns natively — garrison-call's ollama shape gains
// base64 images[], and the gateway's spec builder confines + inlines the frame
// files. Proven against a fake ollama /api/generate server (a real local
// vision model is then pure routing config: pull the model, add the target,
// point ex-drill-curation at it).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";

const ghome = mkdtempSync(path.join(tmpdir(), "garrison-ollama-vision-home-"));
process.env.GARRISON_HOME = ghome;

// @ts-ignore — pure ESM .mjs, no .d.ts
import { buildRequest, runCall } from "../fittings/seed/garrison-call/lib/call-core.mjs";
// @ts-ignore
import { resolveTarget } from "../fittings/seed/garrison-call/lib/providers.mjs";
// @ts-ignore
import {
  buildOllamaVisionSpec,
  OLLAMA_VISION_MAX_IMAGES,
  OLLAMA_VISION_MAX_IMAGE_BYTES
  // @ts-ignore
} from "../fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs";

const frameDir = path.join(ghome, "drill", "evidence", "k", "run1");
const outside = mkdtempSync(path.join(tmpdir(), "garrison-ollama-vision-outside-"));
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

beforeAll(() => {
  mkdirSync(frameDir, { recursive: true });
  writeFileSync(path.join(frameDir, "frame-0001.jpg"), JPEG);
  writeFileSync(path.join(frameDir, "frame-0002.jpg"), Buffer.concat([JPEG, Buffer.from([9])]));
  writeFileSync(path.join(outside, "outside.jpg"), JPEG);
  symlinkSync(path.join(outside, "outside.jpg"), path.join(frameDir, "sneaky.jpg"));
});

afterAll(() => {
  rmSync(ghome, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("call-core ollama shape with images", () => {
  it("inlines base64 images into the native /api/generate body", () => {
    const target = resolveTarget({ shape: "ollama", provider: "ollama-local" });
    const req = buildRequest(
      { shape: "ollama", model: "llava", prompt: "judge these", images: ["QUJD", "REVG"] },
      target,
      "ollama"
    );
    expect(req.url).toBe("http://localhost:11434/api/generate");
    expect(req.body.images).toEqual(["QUJD", "REVG"]);
    expect(req.body.prompt).toBe("judge these");
  });

  it("omits the images field for text-only calls (no behavior change)", () => {
    const target = resolveTarget({ shape: "ollama", provider: "ollama-local" });
    const req = buildRequest({ shape: "ollama", model: "qwen2.5", prompt: "hi" }, target, "ollama");
    expect(req.body.images).toBeUndefined();
  });
});

describe("buildOllamaVisionSpec (gateway side)", () => {
  const target = { model: "llava", baseUrl: "http://localhost:11434", maxTokens: 512, timeoutMs: 9000 };

  it("reads, confines, and base64-inlines the frames", async () => {
    const spec = await buildOllamaVisionSpec(target, "curate", [
      path.join(frameDir, "frame-0001.jpg"),
      path.join(frameDir, "frame-0002.jpg")
    ]);
    expect(spec).toMatchObject({
      shape: "ollama",
      provider: "ollama-local",
      baseUrl: "http://localhost:11434",
      model: "llava",
      prompt: "curate",
      maxTokens: 512,
      timeoutMs: 9000
    });
    expect(spec.images).toHaveLength(2);
    expect(Buffer.from(spec.images[0], "base64")).toEqual(JPEG);
  });

  it("rejects escapes: relative paths, foreign paths, and symlinks out of the home", async () => {
    await expect(buildOllamaVisionSpec(target, "x", ["frame-0001.jpg"])).rejects.toThrow(/not absolute/);
    await expect(buildOllamaVisionSpec(target, "x", [path.join(outside, "outside.jpg")])).rejects.toThrow(/escapes/);
    await expect(buildOllamaVisionSpec(target, "x", [path.join(frameDir, "sneaky.jpg")])).rejects.toThrow(/escapes/);
    await expect(buildOllamaVisionSpec(target, "x", [])).rejects.toThrow(/no usable image/);
  });

  it("caps image count and size", async () => {
    const many = Array.from({ length: OLLAMA_VISION_MAX_IMAGES + 5 }, () => path.join(frameDir, "frame-0001.jpg"));
    const spec = await buildOllamaVisionSpec(target, "x", many);
    expect(spec.images).toHaveLength(OLLAMA_VISION_MAX_IMAGES);
    const bigPath = path.join(frameDir, "big.jpg");
    writeFileSync(bigPath, Buffer.alloc(OLLAMA_VISION_MAX_IMAGE_BYTES + 1, 1));
    await expect(buildOllamaVisionSpec(target, "x", [bigPath])).rejects.toThrow(/too large/);
  });
});

describe("end-to-end against a fake ollama server", () => {
  let srv: http.Server;
  let port: number;
  let lastBody: any = null;

  beforeAll(async () => {
    srv = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        lastBody = { url: req.url, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ response: '[{"name":"frame-0001.jpg","keep":true}]', done: true }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    port = (srv.address() as any).port;
  });

  afterAll(async () => {
    await new Promise((r) => srv.close(() => r(undefined)));
  });

  it("runCall delivers the images natively and extracts the reply", async () => {
    const spec = await buildOllamaVisionSpec(
      { model: "llava" },
      "keep or drop?",
      [path.join(frameDir, "frame-0001.jpg")]
    );
    const result = await runCall({ ...spec, baseUrl: `http://127.0.0.1:${port}` });
    expect(result.ok, result.error).toBe(true);
    expect(result.text).toContain('"keep":true');
    expect(lastBody.url).toBe("/api/generate");
    expect(lastBody.json.model).toBe("llava");
    expect(lastBody.json.images).toHaveLength(1);
    expect(Buffer.from(lastBody.json.images[0], "base64")).toEqual(JPEG);
  });
});

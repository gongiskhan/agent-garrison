#!/usr/bin/env node
// Bundle the Jarvis HUD UI into ../dist/. Resolves react / react-dom / three
// from the Garrison root node_modules (same pattern as web-channel). The
// GraphCore orb bundles three.js + UnrealBloom postprocessing, so the bundle
// is ~1MB+ — expected.

import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import url from "node:url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "..", "dist");
mkdirSync(DIST, { recursive: true });

// Hands-free voice uses @ricky0123/vad-web (Silero VAD) running fully local in
// the browser via onnxruntime-web (WASM). The VAD model + audio worklet and the
// ort WASM runtime are fetched at runtime relative to the page, so they must be
// copied next to the bundle in dist/ (we point baseAssetPath/onnxWASMBasePath at
// "/"). Resolve the packages from the Garrison root node_modules.
const require = createRequire(import.meta.url);
function copyVoiceAssets() {
  const vadDist = path.dirname(require.resolve("@ricky0123/vad-web/dist/index.js"));
  for (const f of ["vad.worklet.bundle.min.js", "silero_vad_v5.onnx", "silero_vad_legacy.onnx"]) {
    copyFileSync(path.join(vadDist, f), path.join(DIST, f));
  }
  // onnxruntime-web restricts its exports; reach the dist dir via one of the
  // per-file wasm subpaths it does export, then copy every ort-wasm* runtime
  // asset (the .mjs glue + .wasm binaries; ort picks the right variant at load).
  const ortDist = path.dirname(require.resolve("onnxruntime-web/ort-wasm-simd-threaded.wasm"));
  for (const f of readdirSync(ortDist)) {
    if (/^ort-wasm.*\.(wasm|mjs)$/.test(f)) copyFileSync(path.join(ortDist, f), path.join(DIST, f));
  }
}

await build({
  entryPoints: [path.join(HERE, "main.tsx")],
  bundle: true,
  format: "esm",
  outfile: path.join(DIST, "jarvis.bundle.js"),
  loader: { ".tsx": "tsx", ".ts": "ts" },
  jsx: "automatic",
  jsxDev: false,
  // vad-web already imports the CPU-only `onnxruntime-web/wasm` build (no webgpu
  // probe; loads the base ort-wasm-simd-threaded.wasm at runtime), so no alias
  // is needed here.
  minify: true,
  sourcemap: false,
  target: ["es2022"],
  // ReportOverlay reads NEXT_PUBLIC_OBSIDIAN_VAULT (a Fable Next.js inline). In
  // a Garrison HUD there is no Obsidian vault, so define it empty (hides the
  // deep link) and avoid a `process is not defined` at runtime.
  define: { "process.env.NEXT_PUBLIC_OBSIDIAN_VAULT": '""' },
  logLevel: "info"
});

copyFileSync(path.join(HERE, "index.html"), path.join(DIST, "index.html"));
writeFileSync(path.join(DIST, "jarvis.css"), readFileSync(path.join(HERE, "styles.css"), "utf8"));
copyVoiceAssets();

console.log("[jarvis-os:build] wrote dist/ (incl. Silero VAD + ort wasm)");

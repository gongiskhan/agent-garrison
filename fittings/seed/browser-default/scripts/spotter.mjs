// Spotter (Drill Evidence V2, S1): trigger-driven frame capture riding a
// capture session. Deterministic triggers only — no model in the capture
// path (D2):
//   (a) step boundary   — chunk start/end, always kept
//   (b) phash distance  — sampled screencast frame differs from the last
//                         kept frame beyond a hamming threshold
//   (c) console burst   — N console lines inside a sliding window
//   (d) message growth  — a configured selector's match count grows past N
// Frames are viewport JPEGs from a Spotter-OWNED CDP screencast session; the
// canvas viewer's screencast is single-client and UI-ack-gated, so Spotter
// never touches it (it would steal the stream from a human watcher).
// Near-duplicates within the same check collapse locally by hamming distance
// before anything downstream sees them (D3) — vision cost stays bounded no
// matter how chatty the page is. Everything here is warn-never-throw: a
// Spotter failure degrades to "no frames", never a failed run.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const requireFromHere = createRequire(import.meta.url);

// pngjs + jpeg-js ride inside playwright-core's exports-map-public
// utilsBundle subpath (both permissive licenses, zero new dependencies).
// That subpath is internal-by-intent, so probe loudly: a playwright upgrade
// that drops PNG/jpegjs must disable Spotter with a clear warning, not crash
// the browser fitting.
let PNG = null;
let jpegjs = null;
try {
  const bundle = requireFromHere("playwright-core/lib/utilsBundle");
  if (typeof bundle.PNG === "function" && typeof bundle.jpegjs?.decode === "function") {
    PNG = bundle.PNG;
    jpegjs = bundle.jpegjs;
  } else {
    console.warn("[spotter] playwright utilsBundle no longer exports PNG/jpegjs — frame capture disabled");
  }
} catch (err) {
  console.warn(`[spotter] image decoders unavailable: ${err.message}`);
}

export function spotterDecodersAvailable() {
  return Boolean(PNG && jpegjs);
}

export const SPOTTER_DEFAULTS = {
  sampleMs: 350, // screencast sampling cadence for the phash trigger
  phashThreshold: 9, // hamming bits vs the last kept frame = "changed enough"
  dedupeDistance: 5, // frames this close to a kept frame in the same check collapse
  console: { lines: 8, windowMs: 2000, cooldownMs: 2000 },
  messageRegion: null, // { selector, growth } — off unless configured per drill
  pollMs: 500, // message-region poll cadence
  maxFrames: 300, // hard per-run cap; past it frames count as dropped
  screencast: { quality: 60, maxWidth: 1366, maxHeight: 900 }
};

function num(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

// Caller config is untrusted (it crossed two HTTP hops): clamp every number
// and keep only the shapes Spotter understands.
export function mergeSpotterConfig(raw) {
  const cfg = raw && typeof raw === "object" ? raw : {};
  const d = SPOTTER_DEFAULTS;
  const consoleCfg = cfg.console && typeof cfg.console === "object" ? cfg.console : {};
  const region = cfg.messageRegion && typeof cfg.messageRegion === "object" ? cfg.messageRegion : null;
  const selector = typeof region?.selector === "string" && region.selector.length <= 500 ? region.selector : null;
  return {
    sampleMs: num(cfg.sampleMs, d.sampleMs, { min: 100, max: 10_000 }),
    phashThreshold: num(cfg.phashThreshold, d.phashThreshold, { min: 1, max: 144 }),
    dedupeDistance: num(cfg.dedupeDistance, d.dedupeDistance, { min: 0, max: 144 }),
    console: {
      lines: num(consoleCfg.lines, d.console.lines, { min: 1, max: 500 }),
      windowMs: num(consoleCfg.windowMs, d.console.windowMs, { min: 100, max: 60_000 }),
      cooldownMs: num(consoleCfg.cooldownMs, d.console.cooldownMs, { min: 0, max: 60_000 })
    },
    messageRegion: selector
      ? { selector, growth: num(region.growth, 3, { min: 1, max: 1000 }) }
      : null,
    pollMs: num(cfg.pollMs, d.pollMs, { min: 100, max: 10_000 }),
    maxFrames: num(cfg.maxFrames, d.maxFrames, { min: 1, max: 2000 }),
    screencast: {
      quality: num(cfg.screencast?.quality, d.screencast.quality, { min: 10, max: 95 }),
      maxWidth: num(cfg.screencast?.maxWidth, d.screencast.maxWidth, { min: 320, max: 3840 }),
      maxHeight: num(cfg.screencast?.maxHeight, d.screencast.maxHeight, { min: 240, max: 2400 })
    }
  };
}

// ── Perceptual hash ────────────────────────────────────────────────────────

export function decodeImage(buf) {
  if (!spotterDecodersAvailable() || !Buffer.isBuffer(buf) || buf.length < 8) return null;
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50) {
      const png = PNG.sync.read(buf);
      return { data: png.data, width: png.width, height: png.height };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      const jpg = jpegjs.decode(buf, { maxMemoryUsageInMB: 512, formatAsRGBA: true });
      return { data: jpg.data, width: jpg.width, height: jpg.height };
    }
  } catch {
    return null;
  }
  return null;
}

// 9x9 double-gradient hash: grayscale box-downsample to a 9x9 grid, then one
// bit per HORIZONTAL neighbour pair (9 rows x 8 = 72) plus one per VERTICAL
// neighbour pair (8 x 9 cols = 72) -> 144 bits. A pure horizontal dHash is
// blind to full-width bands (a page section flipping colour changes no
// left-vs-right relation inside its rows — found the hard way on the flip
// fixture); the vertical half catches exactly those. Robust to JPEG noise,
// trivially comparable via hamming distance.
export function dHashRgba(data, width, height) {
  const GRID = 9;
  const gray = new Float64Array(GRID * GRID);
  for (let ry = 0; ry < GRID; ry++) {
    const y0 = Math.floor((ry * height) / GRID);
    const y1 = Math.max(y0 + 1, Math.floor(((ry + 1) * height) / GRID));
    for (let rx = 0; rx < GRID; rx++) {
      const x0 = Math.floor((rx * width) / GRID);
      const x1 = Math.max(x0 + 1, Math.floor(((rx + 1) * width) / GRID));
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1; y++) {
        let idx = (y * width + x0) * 4;
        for (let x = x0; x < x1; x++, idx += 4) {
          sum += 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
          count++;
        }
      }
      gray[ry * GRID + rx] = count ? sum / count : 0;
    }
  }
  let bits = 0n;
  for (let ry = 0; ry < GRID; ry++) {
    for (let rx = 0; rx < GRID - 1; rx++) {
      bits <<= 1n;
      if (gray[ry * GRID + rx] > gray[ry * GRID + rx + 1]) bits |= 1n;
    }
  }
  for (let ry = 0; ry < GRID - 1; ry++) {
    for (let rx = 0; rx < GRID; rx++) {
      bits <<= 1n;
      if (gray[ry * GRID + rx] > gray[(ry + 1) * GRID + rx]) bits |= 1n;
    }
  }
  return bits;
}

export function dHash(buf) {
  const img = decodeImage(buf);
  return img ? dHashRgba(img.data, img.width, img.height) : null;
}

export function hamming(a, b) {
  let x = a ^ b;
  let count = 0;
  while (x) {
    x &= x - 1n;
    count++;
  }
  return count;
}

const hashHex = (h) => h.toString(16).padStart(36, "0");

// ── The per-session engine ─────────────────────────────────────────────────

export async function createSpotter({ session, config }) {
  if (!spotterDecodersAvailable()) throw new Error("image decoders unavailable");
  if (!session?.tab?.page) throw new Error("capture session has no tab");
  const cfg = mergeSpotterConfig(config);
  const tab = session.tab;

  const state = {
    cfg,
    frames: [], // manifest rows: { name, tMs, trigger, chunk, hash, bytes, collapsed }
    collapsedRows: [], // D1 honesty: every collapsed candidate stays visible: { tMs, trigger, chunk, onto, dist }
    keptHashes: [], // parallel: { chunk, hash: BigInt, index }
    counts: { sampled: 0, kept: 0, collapsed: 0, dropped: 0, consoleBursts: 0, regionTriggers: 0 },
    seq: 0,
    currentChunk: null,
    lastKeptHash: null,
    latestFrame: null, // { buf, ts } most recent screencast frame
    lastSampleAt: 0,
    consoleTs: [],
    lastConsoleBurstAt: 0,
    regionBaseline: null,
    pollTimer: null,
    cdp: null,
    stopped: false,
    manifestWritten: false,
    // Keep + write are async while triggers fire concurrently; the chain
    // serializes them so seq/frame ordering stays deterministic.
    chain: Promise.resolve()
  };

  const warn = (msg) => console.warn(`[spotter] ${session.id}: ${msg}`);

  async function writeFrame(buf, hash, trigger, force) {
    if (state.stopped) return;
    if (state.frames.length >= cfg.maxFrames) {
      state.counts.dropped++;
      return;
    }
    if (!force && hash !== null) {
      // D3: collapse near-duplicates of frames already kept in this check.
      // The collapse itself is recorded (trigger, target, distance) so no
      // trigger event is ever invisible downstream — graduation (S5) learns
      // trigger patterns from exactly this record.
      for (let i = state.keptHashes.length - 1; i >= 0; i--) {
        const kept = state.keptHashes[i];
        if (kept.chunk !== state.currentChunk) break;
        const dist = hamming(kept.hash, hash);
        if (dist <= cfg.dedupeDistance) {
          state.frames[kept.index].collapsed++;
          state.counts.collapsed++;
          if (state.collapsedRows.length < 5000) {
            state.collapsedRows.push({
              tMs: Math.max(0, Date.now() - session.startedAt),
              trigger,
              chunk: state.currentChunk,
              onto: state.frames[kept.index].name,
              dist
            });
          }
          return;
        }
      }
    }
    const name = `frame-${String(state.seq++).padStart(4, "0")}.jpg`;
    try {
      await writeFile(path.join(session.dir, name), buf);
    } catch (err) {
      warn(`frame write failed: ${err.message}`);
      return;
    }
    const index = state.frames.length;
    state.frames.push({
      name,
      tMs: Math.max(0, Date.now() - session.startedAt),
      trigger,
      chunk: state.currentChunk,
      hash: hash === null ? null : hashHex(hash),
      bytes: buf.length,
      collapsed: 0
    });
    if (hash !== null) {
      state.keptHashes.push({ chunk: state.currentChunk, hash, index });
      state.lastKeptHash = hash;
    }
    state.counts.kept++;
  }

  const enqueue = (job) => {
    state.chain = state.chain.then(job).catch((err) => warn(`capture failed: ${err.message}`));
  };

  // Latest screencast frame when fresh; one-shot CDP screenshot otherwise
  // (static pages paint once — the screencast goes quiet on them).
  async function grabFrame() {
    const latest = state.latestFrame;
    if (latest && Date.now() - latest.ts < 1500) return latest.buf;
    if (!state.cdp) return latest?.buf ?? null;
    try {
      const shot = await state.cdp.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: cfg.screencast.quality
      });
      return Buffer.from(shot.data, "base64");
    } catch {
      return latest?.buf ?? null;
    }
  }

  function captureTriggered(trigger, { force = false } = {}) {
    if (state.stopped) return;
    enqueue(async () => {
      const buf = await grabFrame();
      if (!buf) return;
      await writeFrame(buf, dHash(buf), trigger, force);
    });
  }

  function sample(buf) {
    state.counts.sampled++;
    const hash = dHash(buf);
    if (hash === null) return;
    if (state.lastKeptHash === null) {
      // Nothing kept yet — the first boundary frame will seed the baseline;
      // don't record the pre-run blank.
      state.lastKeptHash = hash;
      return;
    }
    if (hamming(hash, state.lastKeptHash) > cfg.phashThreshold) {
      enqueue(() => writeFrame(buf, hash, "phash", false));
    }
  }

  const spotter = {
    config: cfg,

    // (a) Step boundary — always kept, and re-tags the current check window.
    onChunkStart(chunkName) {
      if (typeof chunkName === "string" && chunkName) state.currentChunk = chunkName;
      captureTriggered("step-start", { force: true });
    },
    onChunkStop() {
      captureTriggered("step-end", { force: true });
    },

    // (c) Console burst — fed by the tab's instrumentation hook.
    noteConsole(entry) {
      if (state.stopped) return;
      const now = typeof entry?.ts === "number" ? entry.ts : Date.now();
      state.consoleTs.push(now);
      const cutoff = now - cfg.console.windowMs;
      while (state.consoleTs.length && state.consoleTs[0] < cutoff) state.consoleTs.shift();
      if (
        state.consoleTs.length >= cfg.console.lines &&
        now - state.lastConsoleBurstAt >= cfg.console.cooldownMs
      ) {
        state.lastConsoleBurstAt = now;
        state.counts.consoleBursts++;
        captureTriggered("console-burst");
      }
    },

    // Timers + CDP teardown without finalizing — for browser-death paths
    // where no context survives to flush against. Fire-and-forget manifest
    // so already-captured frames stay indexed.
    abandon() {
      if (state.stopped) return;
      state.stopped = true;
      if (state.pollTimer) clearInterval(state.pollTimer);
      if (tab.onConsoleEntry === spotter.noteConsole) tab.onConsoleEntry = null;
      state.cdp = null;
      void spotter.writeManifest().catch(() => {});
    },

    async writeManifest() {
      if (state.manifestWritten) return "spotter-frames.json";
      state.manifestWritten = true;
      const manifest = {
        version: 1,
        sessionId: session.id,
        startedAt: session.startedAt,
        stoppedAt: Date.now(),
        config: {
          ...cfg,
          messageRegion: cfg.messageRegion ? { ...cfg.messageRegion } : null
        },
        counts: { ...state.counts },
        frames: state.frames,
        collapsed: state.collapsedRows
      };
      await writeFile(
        path.join(session.dir, "spotter-frames.json"),
        JSON.stringify(manifest, null, 2)
      );
      return "spotter-frames.json";
    },

    async stop() {
      if (state.stopped) {
        return { manifest: "spotter-frames.json", counts: { ...state.counts } };
      }
      state.stopped = true;
      if (state.pollTimer) clearInterval(state.pollTimer);
      if (tab.onConsoleEntry === spotter.noteConsole) tab.onConsoleEntry = null;
      if (state.cdp) {
        try { await state.cdp.send("Page.stopScreencast"); } catch {}
        try { await state.cdp.detach(); } catch {}
        state.cdp = null;
      }
      // Let in-flight keeps drain so the manifest sees every frame.
      try { await state.chain; } catch {}
      let manifest = null;
      try {
        manifest = await spotter.writeManifest();
      } catch (err) {
        warn(`manifest write failed: ${err.message}`);
      }
      return { manifest, counts: { ...state.counts }, frames: state.frames.length };
    }
  };

  // Spotter owns its own CDP session: the viewer screencast is single-client
  // (a second /viewport WS terminates the first) and its acks come from the
  // canvas UI. Chromium supports independent screencasts per CDP session, so
  // this never contends with a human watching the run live.
  const cdp = await tab.page.context().newCDPSession(tab.page);
  state.cdp = cdp;
  cdp.on("Page.screencastFrame", (event) => {
    // Ack immediately — an unacked consumer stalls Chromium's encoder.
    cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
    if (state.stopped) return;
    const buf = Buffer.from(event.data, "base64");
    const now = Date.now();
    state.latestFrame = { buf, ts: now };
    if (now - state.lastSampleAt >= cfg.sampleMs) {
      state.lastSampleAt = now;
      sample(buf);
    }
  });
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: cfg.screencast.quality,
    maxWidth: cfg.screencast.maxWidth,
    maxHeight: cfg.screencast.maxHeight,
    everyNthFrame: 1
  });

  // (c) wiring: instrumentation forwards console entries per tab.
  tab.onConsoleEntry = spotter.noteConsole;

  // (d) Message-region growth poll (focusWatcher precedent: self-guarded
  // interval, cheap Runtime.evaluate, warn-only).
  if (cfg.messageRegion) {
    const expr = `document.querySelectorAll(${JSON.stringify(cfg.messageRegion.selector)}).length`;
    state.pollTimer = setInterval(() => {
      if (state.stopped || !state.cdp) return;
      state.cdp
        .send("Runtime.evaluate", { expression: expr, returnByValue: true })
        .then((r) => {
          const count = Number(r?.result?.value);
          if (!Number.isFinite(count)) return;
          if (state.regionBaseline === null) {
            state.regionBaseline = count;
            return;
          }
          if (count - state.regionBaseline >= cfg.messageRegion.growth) {
            // Move the baseline whether the frame survives dedupe or not —
            // otherwise a collapsed frame re-fires the trigger every poll.
            state.regionBaseline = count;
            state.counts.regionTriggers++;
            captureTriggered("message-growth");
          } else if (count < state.regionBaseline) {
            state.regionBaseline = count;
          }
        })
        .catch(() => {});
    }, cfg.pollMs);
    state.pollTimer.unref?.();
  }

  return spotter;
}

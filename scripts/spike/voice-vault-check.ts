// Real-path check for Part B: the runner's own-port secret injection.
// Exercises the REAL vaultEnvForEntry + startOwnPortFitting against a
// controlled in-memory vault (no disk/passphrase ambiguity), then confirms the
// spawned deepgram-voice Fitting actually received the key (keyConfigured=true).
// This is the exact seam runner.startOperativeBoundFittings uses.

import http from "node:http";
import { readLibrary } from "../../src/lib/library";
import {
  vaultEnvForEntry,
  startOwnPortFitting,
  stopOwnPortFitting
} from "../../src/lib/own-port-lifecycle";

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode || 0, body: b }));
    });
    req.on("error", reject);
    req.setTimeout(2000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

async function main() {
  // Seed the in-memory vault runtime. readVaultSecrets reads this at call time;
  // with VAULT_UNLOCKED unset, ensureDevUnlock() is a no-op.
  (globalThis as any).__agentGarrisonVault = {
    passphrase: "test-passphrase",
    plaintext: {
      secrets: { DEEPGRAM_API_KEY: "seed-key-for-partB-check", UNRELATED: "x" },
      updatedAt: new Date(0).toISOString()
    }
  };

  const lib = await readLibrary();
  const entry = lib.find((e) => e.id === "deepgram-voice");
  if (!entry) throw new Error("deepgram-voice not in library");
  console.log("entry consumes:", JSON.stringify(entry.metadata.consumes));

  const env = await vaultEnvForEntry(entry);
  const hasKey = Boolean(env.DEEPGRAM_API_KEY);
  console.log(`vaultEnvForEntry → DEEPGRAM_API_KEY present: ${hasKey}; keys injected: ${Object.keys(env).length}`);
  if (!hasKey) throw new Error("Part B did NOT inject DEEPGRAM_API_KEY");

  await stopOwnPortFitting("deepgram-voice");
  const res = await startOwnPortFitting(entry, env);
  console.log("startOwnPortFitting:", JSON.stringify(res));
  if (!res.ok) throw new Error("failed to start deepgram-voice");

  await new Promise((r) => setTimeout(r, 1500));
  let health: any = null;
  for (let i = 0; i < 12; i++) {
    try {
      const h = await get("http://127.0.0.1:7085/health");
      if (h.status === 200) { health = JSON.parse(h.body); break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log("voice /health:", JSON.stringify(health));
  await stopOwnPortFitting("deepgram-voice");

  if (!health?.keyConfigured) throw new Error("voice Fitting started but keyConfigured=false");
  console.log("\nPART B REAL-PATH OK: vaultEnvForEntry → startOwnPortFitting delivered the key (keyConfigured=true)");
}

main().catch((err) => { console.error("FAIL:", err.message); process.exit(1); });

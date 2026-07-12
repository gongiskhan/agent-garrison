#!/usr/bin/env node
// check-upstream.mjs — compare the vendored taste skills against the pinned
// upstream commit (drift = local edits) and report whether upstream has moved
// ahead of the pin. Read-only; network used only to query upstream.
//
//   node scripts/check-upstream.mjs            # drift vs pin (offline) + upstream HEAD (network)
//   node scripts/check-upstream.mjs --offline  # drift vs pin only
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pin = JSON.parse(readFileSync(path.join(root, "upstream.json"), "utf8"));
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

let drifted = 0;
for (const [rel, meta] of Object.entries(pin.files)) {
  const actual = sha256(path.join(root, rel));
  const ok = actual === meta.sha256;
  if (!ok) drifted++;
  console.log(`${ok ? "clean" : "DRIFTED"} ${rel}`);
}

if (!process.argv.includes("--offline")) {
  try {
    const m = pin.repo.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
    const res = await fetch(`https://api.github.com/repos/${m[1]}/commits?per_page=1`, {
      headers: { accept: "application/vnd.github+json" },
    });
    const head = (await res.json())[0]?.sha;
    if (head) {
      console.log(
        head === pin.commit
          ? `upstream: at pin (${pin.commit.slice(0, 7)})`
          : `upstream: moved ahead — pin ${pin.commit.slice(0, 7)}, HEAD ${head.slice(0, 7)}`,
      );
    }
  } catch (e) {
    console.log(`upstream: check skipped (${e.message})`);
  }
}
process.exit(drifted ? 1 : 0);

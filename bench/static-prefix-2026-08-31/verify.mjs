// Hash the cacheable prefix of every capture, before and after the fix. Two
// different projects, and two commits in one repo, must land on ONE hash.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { shapeAnthropicRequest, cacheablePrefixParts } from "../../fittings/seed/http-gateway/scripts/lib/anthropic-request-shaper.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const D = path.join(HERE, process.env.CAPTURE_OUT || "capture-prod");

const digest = (body) => {
  const p = cacheablePrefixParts(body);
  return crypto.createHash("sha256")
    .update(JSON.stringify(p.tools))
    .update(" ")
    .update(p.system.join(" "))
    .digest("hex")
    .slice(0, 16);
};

const rows = [];
for (const f of fs.readdirSync(D).filter((n) => n.endsWith(".json")).sort()) {
  const body = JSON.parse(fs.readFileSync(path.join(D, f), "utf8"));
  const before = digest(body);
  const { body: shaped, changes } = shapeAnthropicRequest(body, { staticPrefix: true });
  rows.push({
    name: f.replace(/\.json$/, ""),
    before,
    after: digest(shaped),
    moved: changes.staticPrefix?.moved ?? [],
    movedChars: changes.staticPrefix?.movedChars ?? 0,
    staticChars: changes.staticPrefix?.staticChars ?? 0,
  });
}

for (const r of rows) {
  console.log(
    `  ${r.name.padEnd(12)} before=${r.before}  after=${r.after}  cached=${String(r.staticChars).padStart(6)}ch  moved=${String(r.movedChars).padStart(5)}ch [${r.moved.join(", ")}]`
  );
}
const uniq = (k) => new Set(rows.map((r) => r[k])).size;
console.log("");
console.log(`distinct cacheable prefixes  before: ${uniq("before")}   after: ${uniq("after")}`);
process.exit(uniq("after") === 1 ? 0 : 1);

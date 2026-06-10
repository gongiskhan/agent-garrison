/**
 * Settings-schema refresher — re-vendor the official Claude Code settings.json
 * JSON Schema from SchemaStore into src/lib/claude-settings-schema.json (+ a
 * .meta.json sidecar with provenance).
 *
 * The vendored copy is the source of truth the settings-catalog sync tests run
 * against (tests/settings-catalog.test.ts). It is read by TESTS ONLY — runtime
 * code must never import it (it would land in the client bundle; a guard spec
 * enforces this). Workflow on a Claude Code version bump:
 *
 *   npm run refresh:settings-schema
 *   npm test          # sync specs name exactly which catalog lines drifted
 *
 * Usage:
 *   tsx scripts/refresh-settings-schema.ts
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_URL = "https://json.schemastore.org/claude-code-settings.json";

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(here, "..", "src", "lib", "claude-settings-schema.json");
const metaPath = path.join(here, "..", "src", "lib", "claude-settings-schema.meta.json");

async function main(): Promise<void> {
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
  const parsed = await res.json();
  if (!parsed || typeof parsed !== "object" || !("properties" in parsed)) {
    throw new Error("unexpected payload: no top-level properties block");
  }

  // Normalised pretty-print so refresh diffs are real changes, not formatting.
  const body = `${JSON.stringify(parsed, null, 2)}\n`;
  const sha256 = crypto.createHash("sha256").update(body).digest("hex");

  const prev = fs.existsSync(schemaPath) ? fs.readFileSync(schemaPath, "utf8") : null;
  fs.writeFileSync(schemaPath, body, "utf8");
  fs.writeFileSync(
    metaPath,
    `${JSON.stringify(
      {
        sourceUrl: SOURCE_URL,
        fetchedAt: new Date().toISOString(),
        sha256,
        note: "Vendored for tests/settings-catalog.test.ts; never import from runtime src/. Refresh with: npm run refresh:settings-schema"
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const keys = Object.keys((parsed as { properties: Record<string, unknown> }).properties).length;
  console.log(`${prev === body ? "unchanged" : "updated"}: ${schemaPath}`);
  console.log(`  ${keys} top-level properties, sha256 ${sha256.slice(0, 12)}…`);
  if (prev !== null && prev !== body) {
    console.log("  schema changed — run `npm test` and reconcile settings-catalog.ts with the sync-spec failures.");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

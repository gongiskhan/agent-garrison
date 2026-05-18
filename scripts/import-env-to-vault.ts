#!/usr/bin/env tsx
// One-shot import of project-root .env into data/vault.json using the
// dev passphrase. Requires VAULT_UNLOCKED=true (set at script start).
import fs from "node:fs/promises";
import path from "node:path";

async function main() {
  process.env.VAULT_UNLOCKED = "true";

  const { writeVaultSecrets, vaultView, readVaultSecrets } = await import("../src/lib/vault");

  const envPath = path.join(process.cwd(), ".env");
  const raw = await fs.readFile(envPath, "utf8");

  const parsed: { key: string; value: string }[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key === "VAULT_UNLOCKED") continue;
    parsed.push({ key, value });
  }

  await vaultView();
  const merged = new Map<string, string>();
  for (const s of await readVaultSecrets()) {
    merged.set(s.key, s.value);
  }
  for (const s of parsed) merged.set(s.key, s.value);

  const next = Array.from(merged, ([key, value]) => ({ key, value }));
  const written = await writeVaultSecrets(next);

  console.log(`Imported ${parsed.length} entries from .env`);
  console.log(`Vault now holds ${written.length} secrets: ${written.map((s) => s.key).join(", ")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

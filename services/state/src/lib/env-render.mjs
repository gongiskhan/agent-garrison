// Server-side env rendering — the ONE renderer (src/lib/loadout.ts's
// renderLoadoutEnv logic, executed where the secrets live). Do not build a
// second renderer anywhere else.
//
// The PROJECT__VAR override, bare-name output, multi-line refusal and
// single-quote refusal all carry over verbatim: neither runner.ts's
// parseDotenv nor the gateway's un-escape anything, so a value that cannot
// round-trip must fail loudly rather than hand a worker a corrupted
// credential.

export function vaultPrefixFor(projectId) {
  return `${String(projectId).replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}__`;
}

export function isEnvSafeValue(value) {
  return !/[\r\n]/.test(value);
}

export function quoteEnvValue(value) {
  if (/^[A-Za-z0-9_./:@-]*$/.test(value)) return value;
  if (value.includes("'")) {
    throw new Error("value contains a single quote, which the .env readers cannot round-trip");
  }
  return `'${value}'`;
}

// names: declared env var NAMES. secretsByKey: Map of every readable secret.
export function renderProjectEnv(projectId, names, secretsByKey) {
  const prefix = vaultPrefixFor(projectId);
  const resolved = [];
  const missing = [];
  const lines = [
    `# Rendered by the Garrison state service from the vault for project "${projectId}".`,
    `# Values are NOT in version control. Do not commit this file.`,
    ``
  ];
  for (const name of names) {
    const overrideKey = `${prefix}${name}`;
    const key = secretsByKey.has(overrideKey) ? overrideKey : secretsByKey.has(name) ? name : null;
    if (!key) {
      resolved.push({ name, source: null, found: false });
      missing.push(name);
      continue;
    }
    const value = secretsByKey.get(key);
    if (!isEnvSafeValue(value)) {
      throw new Error(
        `vault key ${key} holds a multi-line value, which a .env file cannot round-trip here — ` +
          `store it as a file path or a single-line encoding instead`
      );
    }
    lines.push(`${name}=${quoteEnvValue(value)}`);
    resolved.push({ name, source: key, found: true });
  }
  return { content: `${lines.join("\n")}\n`, resolved, missing };
}

// The materializeEnv equivalent: EVERY readable secret, sorted, bare names.
// mode:"all" ships first for exact parity with vault.ts materializeEnv;
// mode:"scoped" lands behind a config doc only once a live up() with all
// verify hooks has proven no fitting depends on an unscoped key.
export function renderAllSecretsEnv(secretsByKey) {
  const lines = [...secretsByKey.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${quoteEnvValue(value)}`);
  return lines.length ? `${lines.join("\n")}\n` : "";
}

// Loadout — a per-project descriptor for materializing a working environment
// on any machine (brief D2/D3).
//
// THE POINT: environments are MATERIALIZED, never synced. A Loadout says how to
// rebuild a project's dev environment from scratch — clone or fetch, install,
// render secrets, run setup, prove it with verify — so a card can run on a
// machine that has never seen the project before. Nothing about a machine is
// special after the fact; the descriptor is the whole contract.
//
// SECRETS (D3). `env_vars` commits variable NAMES to the repo, never values.
// Values live only in the Garrison vault, on the host. The host resolves them
// and the RENDERED `.env` travels to the outpost inside the claim payload;
// the vault file and its master key never leave this machine. A copied
// vault.json is undecryptable elsewhere anyway (the master key is per-machine,
// in the OS keychain), which is the property that makes this safe by
// construction rather than by discipline.
//
// NAMESPACE. One flat namespace, so a value used by several projects is entered
// once. A project that needs a DIFFERENT value for the same variable adds a
// prefixed entry: `EKOA__DATABASE_URL` beats `DATABASE_URL` for project `ekoa`.
// The Loadout still lists the BARE name, and the rendered `.env` always uses the
// bare name — the prefix is a vault-side override mechanism, invisible to the
// application being run.

import { readFile, readdir, mkdir } from "node:fs/promises";
import path from "node:path";
import { garrisonDir } from "./claude-home";
import { readVaultSecrets } from "./vault";
import { writeFileAtomic } from "./atomic-write";

export interface Loadout {
  // Project id. Also the vault override prefix (upper-cased, non-alphanumerics
  // to `_`): project `ekoa-code` overrides with `EKOA_CODE__<VAR>`.
  id: string;
  repo_remote: string;
  default_branch: string;
  // Relative path to an APM manifest to install, if the project uses APM.
  apm_manifest_path?: string;
  setup_commands: string[];
  // NAMES ONLY. A value here would be a committed secret.
  env_vars: string[];
  verify_command: string;
  // Where checkouts live on the target machine, when it differs from the
  // machine's default projects root.
  projects_root_override?: string;
}

export interface LoadoutValidationError {
  field: string;
  problem: string;
}

export function loadoutsDir(): string {
  return path.join(garrisonDir(), "loadouts");
}

export function loadoutPath(id: string): string {
  return path.join(loadoutsDir(), `${id}.json`);
}

// The vault override prefix for a project. `ekoa-code` -> `EKOA_CODE__`.
export function vaultPrefixFor(projectId: string): string {
  return `${projectId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}__`;
}

// A name that would be unsafe or meaningless in a .env file.
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// A project id that is safe as a filename and as a vault prefix.
const LOADOUT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function validateLoadout(raw: unknown): LoadoutValidationError[] {
  const errors: LoadoutValidationError[] = [];
  if (!raw || typeof raw !== "object") return [{ field: "(root)", problem: "not an object" }];
  const l = raw as Record<string, unknown>;

  if (typeof l.id !== "string" || !LOADOUT_ID.test(l.id)) {
    errors.push({ field: "id", problem: "must be a filename-safe id" });
  }
  if (typeof l.repo_remote !== "string" || !l.repo_remote.trim()) {
    errors.push({ field: "repo_remote", problem: "required" });
  }
  if (typeof l.default_branch !== "string" || !l.default_branch.trim()) {
    errors.push({ field: "default_branch", problem: "required" });
  }
  if (typeof l.verify_command !== "string" || !l.verify_command.trim()) {
    // A Loadout with no verify cannot prove the environment works, and the whole
    // point of materializing before the model starts is that failure costs zero
    // tokens. Same discipline the runner already enforces on Fittings.
    errors.push({ field: "verify_command", problem: "required — an unverifiable environment is not done" });
  }
  if (l.setup_commands !== undefined && !Array.isArray(l.setup_commands)) {
    errors.push({ field: "setup_commands", problem: "must be an array of strings" });
  }
  if (l.env_vars !== undefined) {
    if (!Array.isArray(l.env_vars)) {
      errors.push({ field: "env_vars", problem: "must be an array of NAMES" });
    } else {
      for (const name of l.env_vars) {
        if (typeof name !== "string" || !ENV_NAME.test(name)) {
          errors.push({ field: "env_vars", problem: `invalid variable name: ${String(name)}` });
        }
        // The single most damaging authoring mistake: pasting a value into the
        // names list, which commits a secret to the repo. Catch it loudly.
        if (typeof name === "string" && name.includes("=")) {
          errors.push({
            field: "env_vars",
            problem: `"${name}" looks like NAME=VALUE — env_vars holds NAMES ONLY, values live in the vault`
          });
        }
      }
    }
  }
  return errors;
}

export function normaliseLoadout(raw: Record<string, unknown>): Loadout {
  return {
    id: String(raw.id),
    repo_remote: String(raw.repo_remote).trim(),
    default_branch: String(raw.default_branch).trim(),
    ...(typeof raw.apm_manifest_path === "string" && raw.apm_manifest_path.trim()
      ? { apm_manifest_path: raw.apm_manifest_path.trim() }
      : {}),
    setup_commands: Array.isArray(raw.setup_commands) ? raw.setup_commands.map(String) : [],
    env_vars: Array.isArray(raw.env_vars) ? raw.env_vars.map(String) : [],
    verify_command: String(raw.verify_command).trim(),
    ...(typeof raw.projects_root_override === "string" && raw.projects_root_override.trim()
      ? { projects_root_override: raw.projects_root_override.trim() }
      : {})
  };
}

export async function readLoadout(id: string): Promise<Loadout | null> {
  try {
    const raw = JSON.parse(await readFile(loadoutPath(id), "utf8")) as Record<string, unknown>;
    const errors = validateLoadout(raw);
    if (errors.length) {
      throw new Error(
        `loadout ${id} is invalid: ${errors.map((e) => `${e.field} ${e.problem}`).join("; ")}`
      );
    }
    return normaliseLoadout(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function listLoadouts(): Promise<Loadout[]> {
  let names: string[];
  try {
    names = await readdir(loadoutsDir());
  } catch {
    return [];
  }
  const out: Loadout[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const loadout = await readLoadout(name.slice(0, -5));
      if (loadout) out.push(loadout);
    } catch {
      // One malformed descriptor never hides the rest.
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export async function writeLoadout(loadout: Loadout): Promise<void> {
  const errors = validateLoadout(loadout);
  if (errors.length) {
    throw new Error(`invalid loadout: ${errors.map((e) => `${e.field} ${e.problem}`).join("; ")}`);
  }
  await mkdir(loadoutsDir(), { recursive: true });
  await writeFileAtomic(loadoutPath(loadout.id), `${JSON.stringify(loadout, null, 2)}\n`, {
    mode: 0o600
  });
}

// ── vault resolution ─────────────────────────────────────────────────────────

export interface ResolvedEnvVar {
  name: string;
  // Which vault key supplied it — the prefixed override or the bare name.
  source: string | null;
  found: boolean;
}

export interface RenderedEnv {
  // The .env file body. NEVER log this.
  content: string;
  resolved: ResolvedEnvVar[];
  missing: string[];
}

// Values that cannot survive the round trip through a .env file.
//
// quoteEnvValue JSON-escapes a value containing anything exotic, but NEITHER
// reader un-escapes: runner.ts's parseDotenv and the gateway's both only strip
// surrounding quotes. So a multi-line secret (a PEM key, a Google service
// account JSON) is written as "line1\nline2" and read back as the literal
// characters. Fail loudly rather than hand a worker a silently corrupted
// credential it will spend a whole run failing to use.
export function isEnvSafeValue(value: string): boolean {
  return !/[\r\n]/.test(value);
}

// Escape for a .env line. Deliberately conservative: quote whenever the value
// is not a plain token, and only ever with single quotes (which no reader
// interprets), since the readers do not process backslash escapes.
export function quoteEnvValueForLoadout(value: string): string {
  if (/^[A-Za-z0-9_./:@-]*$/.test(value)) return value;
  if (value.includes("'")) {
    // A single quote cannot be escaped inside single quotes in the readers'
    // simplistic parsing. Refuse rather than corrupt.
    throw new Error("value contains a single quote, which the .env readers cannot round-trip");
  }
  return `'${value}'`;
}

// Resolve a Loadout's declared NAMES against the vault, honouring the
// `PROJECT__VAR` override with fallback to the bare `VAR`.
//
// Runs on the HOST only — it needs an unlocked vault. The result travels to the
// outpost; the vault does not.
export async function renderLoadoutEnv(loadout: Loadout): Promise<RenderedEnv> {
  const secrets = await readVaultSecrets();
  const byKey = new Map(secrets.map((s) => [s.key, s.value]));
  const prefix = vaultPrefixFor(loadout.id);

  const resolved: ResolvedEnvVar[] = [];
  const missing: string[] = [];
  const lines: string[] = [
    `# Rendered by Garrison from the vault for loadout "${loadout.id}".`,
    `# Values are NOT in version control. Do not commit this file.`,
    ``
  ];

  for (const name of loadout.env_vars) {
    const overrideKey = `${prefix}${name}`;
    const key = byKey.has(overrideKey) ? overrideKey : byKey.has(name) ? name : null;
    if (!key) {
      resolved.push({ name, source: null, found: false });
      missing.push(name);
      continue;
    }
    const value = byKey.get(key)!;
    if (!isEnvSafeValue(value)) {
      throw new Error(
        `vault key ${key} holds a multi-line value, which a .env file cannot round-trip here — ` +
          `store it as a file path or a single-line encoding instead`
      );
    }
    // The rendered file always uses the BARE name: the prefix is a vault-side
    // override, and the application must not have to know it exists.
    lines.push(`${name}=${quoteEnvValueForLoadout(value)}`);
    resolved.push({ name, source: key, found: true });
  }

  return { content: `${lines.join("\n")}\n`, resolved, missing };
}

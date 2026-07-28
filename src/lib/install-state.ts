import fs from "node:fs/promises";
import path from "node:path";
import { garrisonDir, globalCompositionDir } from "./claude-home";
import { snapshotClaudeConfig } from "./config-backup";

// The install GATE. Garrison is a control plane over the user's real ~/.claude,
// so it must not mutate that config until the user has EXPLICITLY installed it
// on this machine. Reads are always allowed (Quarters can SHOW the config); every
// write path funnels through `assertClaudeWritable()`, which throws until install.
//
// State lives at ~/.garrison/install-state.json. Three cases when it is absent:
//   * a genuinely fresh machine (no evidence Garrison ever managed it) -> NOT
//     installed; writes refused.
//   * a machine that predates this gate but was already being managed (the
//     global-composition dir / install lock exists) -> GRANDFATHERED as installed
//     so a redeploy never suddenly refuses every write on a live box.
//   * tests / non-interactive contexts set GARRISON_ASSUME_INSTALLED=1 to bypass.

export interface InstallState {
  version: 1;
  installed: boolean;
  installedAt: string | null;
  disabledAt?: string | null;
  grandfathered?: boolean;
  // Pre-install config backup (the Uninstall restore source). Null on a
  // grandfathered box — there is no pristine pre-Garrison state to capture.
  backupDir: string | null;
}

export interface InstallStatus {
  installed: boolean;
  installedAt: string | null;
  disabledAt: string | null;
  grandfathered: boolean;
  backupDir: string | null;
  // Evidence Garrison has previously managed this ~/.claude (independent of the
  // state file) — surfaced so the UI can explain a grandfathered box.
  hasEvidence: boolean;
}

export class NotInstalledError extends Error {
  readonly code = "not-installed";
  readonly op?: string;
  constructor(op?: string) {
    super(
      op
        ? `Garrison is not installed on this machine — refusing to ${op}. Open Quarters and click Install to begin managing your Claude Code config.`
        : "Garrison is not installed on this machine — refusing to write to ~/.claude. Open Quarters and click Install."
    );
    this.name = "NotInstalledError";
    this.op = op;
  }
}

export function installStatePath(): string {
  return path.join(garrisonDir(), "install-state.json");
}

// Mirror of claude-install.installLockPath — inlined to avoid an import cycle
// (claude-install -> claude-settings-file -> install-state -> claude-install).
function claudeInstallLockPath(): string {
  return path.join(garrisonDir(), "claude-install.lock.json");
}

function envBypass(): boolean {
  const v = process.env.GARRISON_ASSUME_INSTALLED?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readState(): Promise<InstallState | null> {
  try {
    const raw = await fs.readFile(installStatePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1 && typeof parsed.installed === "boolean") {
      return parsed as InstallState;
    }
  } catch {
    // no state file yet
  }
  return null;
}

async function writeState(state: InstallState): Promise<void> {
  const p = installStatePath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

// Evidence Garrison has ALREADY been managing this ~/.claude before the gate
// existed. `globalCompositionDir` is created only by a real management write
// (apm install / a state transition), never by merely viewing Quarters — so its
// presence is a reliable "management has happened here" signal.
export async function hasManagementEvidence(): Promise<boolean> {
  if (await exists(globalCompositionDir())) return true;
  if (await exists(claudeInstallLockPath())) return true;
  return false;
}

export async function isInstalled(): Promise<boolean> {
  if (envBypass()) return true;
  const state = await readState();
  if (state) return state.installed;
  return hasManagementEvidence();
}

// The gate. Call at the top of every path that MUTATES the user's ~/.claude
// (or native engine) config. No-op when installed; throws NotInstalledError
// otherwise. `op` describes the refused action for the surfaced message.
export async function assertClaudeWritable(op?: string): Promise<void> {
  if (await isInstalled()) return;
  throw new NotInstalledError(op);
}

export async function getInstallStatus(): Promise<InstallStatus> {
  const state = await readState();
  if (state) {
    return {
      installed: state.installed,
      installedAt: state.installedAt,
      disabledAt: state.disabledAt ?? null,
      grandfathered: !!state.grandfathered,
      backupDir: state.backupDir,
      hasEvidence: await hasManagementEvidence()
    };
  }
  // No state file. Grandfather an already-managed box (persist so the gate and
  // UI agree and the live box materialises a record). No backup: there is no
  // pristine pre-Garrison state to capture retroactively — the UI offers an
  // explicit "back up current config" action instead.
  if (await hasManagementEvidence()) {
    const now = new Date().toISOString();
    const grandfathered: InstallState = {
      version: 1,
      installed: true,
      installedAt: now,
      grandfathered: true,
      backupDir: null
    };
    await writeState(grandfathered);
    return {
      installed: true,
      installedAt: now,
      disabledAt: null,
      grandfathered: true,
      backupDir: null,
      hasEvidence: true
    };
  }
  return {
    installed: false,
    installedAt: null,
    disabledAt: null,
    grandfathered: false,
    backupDir: null,
    hasEvidence: false
  };
}

// Explicit Install: snapshot the pristine config FIRST (the Uninstall restore
// source + ownership baseline), THEN flip the flag. Ordering matters — the flag
// must be set before any gated writer runs so the merge/adopt in later phases
// passes the gate. Idempotent: a second call on an installed box is a no-op.
export async function install(): Promise<InstallStatus> {
  const existing = await readState();
  if (existing?.installed) return getInstallStatus();
  const snap = await snapshotClaudeConfig("pre-install");
  await writeState({
    version: 1,
    installed: true,
    installedAt: new Date().toISOString(),
    grandfathered: false,
    backupDir: snap.dir
  });
  return getInstallStatus();
}

// Stop managing (Phase 1): flip the gate off so Garrison writes nothing to
// ~/.claude, WITHOUT removing or restoring anything. The restoring, per-item +
// machine-teardown Uninstall is Phase 4.
export async function disable(): Promise<InstallStatus> {
  const state = (await readState()) ?? {
    version: 1 as const,
    installed: true,
    installedAt: null,
    grandfathered: await hasManagementEvidence(),
    backupDir: null
  };
  await writeState({ ...state, installed: false, disabledAt: new Date().toISOString() });
  return getInstallStatus();
}

// On-demand config snapshot (e.g. a grandfathered box that never captured a
// pristine pre-install baseline). Records the latest backup dir on the state.
export async function backupNow(): Promise<{ dir: string }> {
  const snap = await snapshotClaudeConfig("manual");
  const state = await readState();
  if (state) await writeState({ ...state, backupDir: snap.dir });
  return { dir: snap.dir };
}

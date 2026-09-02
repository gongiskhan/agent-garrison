import { connectorSecretScope } from "@/lib/metadata";
import type { LibraryEntry } from "@/lib/types";
import type { OAuthHealth } from "@/lib/vault";

// The Vault ↔ Connectors UI view model. Pure aggregation over the library +
// vault secret NAMES (never values) + OAuth health, so it is unit-testable and
// no secret value passes through it.

export interface ConnectorSecretStatus {
  name: string;
  present: boolean; // is this scoped secret actually in the vault?
}

export interface ConnectorView {
  id: string;
  /** The Fitting that provides this connector - what "station it" refers to. */
  fittingId: string;
  /**
   * Whether that Fitting is stationed in the active composition. A connector
   * that is not stationed has NOTHING to connect: its daemon is not running
   * and no turn can reach it, however sealed its credentials look. The page
   * must say that instead of presenting a dead card.
   */
  equipped: boolean;
  name: string;
  summary: string;
  auth: "oauth2" | "api_key" | "none";
  /** The names a connector call receives (`connector.secrets` when declared,
   *  else the whole `secret_scope`) + whether each is in the vault (no values). */
  secrets: ConnectorSecretStatus[];
  /** all scoped secrets present (api_key) OR a valid OAuth grant (oauth2). */
  sealed: boolean;
  actionCount: number;
  mutatingActionCount: number;
  hasTriggers: boolean;
  oauth?: OAuthHealth;
  /** false when the vault couldn't be read — sealed/secrets are then UNKNOWN, not missing. */
  statusKnown: boolean;
}

/** The connector id is the name of the entry's provides[] entry of kind "connector". */
export function connectorIdOf(entry: LibraryEntry): string | null {
  const p = entry.metadata.provides?.find((x) => x.kind === "connector");
  return p?.name ?? null;
}

export function buildConnectorsView(
  entries: LibraryEntry[],
  vaultSecretNames: readonly string[],
  oauthHealth: readonly OAuthHealth[],
  opts: { vaultLocked?: boolean; equippedFittingIds?: ReadonlySet<string> } = {}
): ConnectorView[] {
  const vaultLocked = opts.vaultLocked ?? false;
  const equippedIds = opts.equippedFittingIds ?? null;
  const present = new Set(vaultSecretNames);
  const healthBy = new Map(oauthHealth.map((h) => [h.connector, h]));
  const out: ConnectorView[] = [];

  for (const entry of entries) {
    const spec = entry.metadata.connector;
    const id = connectorIdOf(entry);
    if (!spec || !id) continue;

    // The same subset the auth-env route delivers: a connector whose own
    // secrets are sealed reads as sealed even while the Fitting's other keys
    // (its service's, not the connector's) are still unset.
    const scope = connectorSecretScope(entry.metadata);
    const secrets = scope.map((name) => ({ name, present: present.has(name) }));
    const oauth = healthBy.get(id);

    // Sealed = the connector has working credentials. api_key: every scoped
    // secret present. oauth2: a non-revoked, non-expired grant. none: always.
    let sealed: boolean;
    if (spec.auth === "none") sealed = true;
    else if (spec.auth === "oauth2") sealed = !!oauth && oauth.status !== "revoked" && oauth.status !== "expired";
    else sealed = secrets.length > 0 && secrets.every((s) => s.present);

    out.push({
      id,
      fittingId: entry.id,
      // Unknown composition (equippedIds null) reads as equipped - the page
      // must not claim "not stationed" on a read failure.
      equipped: equippedIds ? equippedIds.has(entry.id) : true,
      name: entry.name,
      summary: entry.summary ?? entry.metadata.summary ?? "",
      auth: spec.auth,
      secrets,
      sealed,
      actionCount: spec.actions?.length ?? 0,
      mutatingActionCount: spec.actions?.filter((a) => a.mutates).length ?? 0,
      hasTriggers: (spec.triggers?.length ?? 0) > 0,
      oauth,
      // When the vault couldn't be read, presence/health are UNKNOWN, not "missing".
      statusKnown: !vaultLocked || spec.auth === "none"
    });
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}

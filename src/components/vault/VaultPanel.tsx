"use client";

import { useMemo, useState } from "react";
import clsx from "clsx";
import { useAppShell } from "@/components/chrome/AppShell";
import type { LibraryEntry, VaultSecret } from "@/lib/types";
import styles from "./VaultPanel.module.css";

export function VaultPanel() {
  const {
    composition,
    library,
    vaultUnlocked,
    vaultNeedsPassword,
    vaultDevMode,
    vaultKeySource,
    secrets,
    setSecrets,
    saveSecrets,
    unlockVault,
    busy
  } = useAppShell();

  const consumers = useMemo(() => buildConsumerMap(library, composition?.selections), [library, composition]);

  return (
    <main>
      <div className="crumbs">
        <b>Vault</b>
      </div>
      <div className="page">
        <header className={styles.header}>
          <div>
            <span className={styles.eyebrow}>Keychain-sealed stores</span>
            <h1>Vault</h1>
          </div>
          <p>
            Secret values stay encrypted at rest and materialise only for the
            Fitting or Operative that declared them.
          </p>
        </header>

        {vaultDevMode ? (
          <div className="banner info">
            <span className="glyph">i</span>
            <div>
              <h5>Automatic unlock is enabled</h5>
              <p>
                <code>VAULT_UNLOCKED</code> opens this local development instance
                at boot. The encryption key still comes from the OS keychain.
              </p>
            </div>
          </div>
        ) : null}

        <div className={styles.vaultGrid}>
          <section className={styles.statusPanel}>
            <div className={styles.statusTop}>
              <span className={styles.eyebrow}>Seal status</span>
              <span className={clsx(styles.statusLamp, vaultUnlocked && styles.statusLampLive)} aria-hidden />
            </div>
            <h2>{vaultUnlocked ? "Vault ready" : "Vault sealed"}</h2>
            <p>
              {vaultUnlocked
                ? "The decrypted index is held in this server process. Values remain hidden in the interface until you reveal one."
                : "Ask the operating system keychain for the master key to inspect or change stored values."}
            </p>
            <dl className={styles.statusLedger}>
              <div>
                <dt>state</dt>
                <dd>{vaultUnlocked ? "unlocked" : "locked"}</dd>
              </div>
              <div>
                <dt>key source</dt>
                <dd>{vaultKeySource || "OS keychain"}</dd>
              </div>
              <div>
                <dt>cipher</dt>
                <dd>AES-256-GCM</dd>
              </div>
            </dl>
            {!vaultUnlocked ? (
              <button
                className="btn primary"
                disabled={busy === "vault"}
                onClick={() => void unlockVault("")}
              >
                {busy === "vault" ? "Requesting key…" : "Unlock from keychain"}
              </button>
            ) : (
              <div className={styles.readyMark}>
                <span aria-hidden>■</span>
                Ready for scoped delivery
              </div>
            )}
          </section>

          <section className={styles.secretsPanel}>
            <div className={styles.secretsHead}>
              <div>
                <span className={styles.eyebrow}>Secret register</span>
                <h2>Stored values <span>{secrets.length}</span></h2>
              </div>
              <div className={styles.secretActions}>
                <button
                  className="btn small ghost"
                  disabled={!vaultUnlocked || vaultNeedsPassword}
                  onClick={() => setSecrets([...secrets, { key: "", value: "" }])}
                >
                  Add value
                </button>
                <button
                  className="btn small primary"
                  disabled={!vaultUnlocked || vaultNeedsPassword || busy === "secrets"}
                  onClick={() => void saveSecrets()}
                >
                  {busy === "secrets" ? "Sealing…" : "Seal changes"}
                </button>
              </div>
            </div>

            {!vaultUnlocked || vaultNeedsPassword ? (
              <div className={styles.emptyState}>
                <span aria-hidden>◇</span>
                <strong>Register sealed</strong>
                <p>Unlock with the OS keychain to inspect stored names.</p>
              </div>
            ) : secrets.length === 0 ? (
              <div className={styles.emptyState}>
                <span aria-hidden>＋</span>
                <strong>No stored values</strong>
                <p>Add a named value; Garrison delivers it only when a declared scope needs it.</p>
              </div>
            ) : (
              <div className={styles.secretRows}>
                {secrets.map((secret, index) => (
                  <SecretRow
                    key={index}
                    secret={secret}
                    consumers={consumers[secret.key] ?? []}
                    onChange={(next) =>
                      setSecrets(secrets.map((s, i) => (i === index ? next : s)))
                    }
                    onRemove={() => setSecrets(secrets.filter((_, i) => i !== index))}
                  />
                ))}
              </div>
            )}
          </section>
        </div>

        <div className={styles.lifecycleHead}>
          <span className={styles.eyebrow}>Custody chain</span>
          <h2>Where values live</h2>
          <p>Every transition is local, temporary, and constrained to the active composition.</p>
        </div>
        {/* WS9: wrap the wide table so it scrolls within its own bounds instead
            of overflowing the page at narrow (390px) widths. */}
        <div className={styles.tableWrap}>
        <table className="simple">
          <thead>
            <tr>
              <th>Phase</th>
              <th>Where the secrets live</th>
              <th>For how long</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="mono">at rest</td>
              <td>
                <code>~/.garrison/vault.json</code> · HKDF-derived file key · 0600
              </td>
              <td>indefinitely</td>
            </tr>
            <tr>
              <td className="mono">runtime</td>
              <td>
                <code>compositions/&lt;id&gt;/.env</code> · 0600
              </td>
              <td>between Run and Stop</td>
            </tr>
            <tr>
              <td className="mono">in process</td>
              <td>
                <code>process.env</code> of the spawned Operative
              </td>
              <td>for the life of the Operative</td>
            </tr>
            <tr>
              <td className="mono">in transit</td>
              <td>scoped process environment · localhost only</td>
              <td>never over network</td>
            </tr>
          </tbody>
        </table>
        </div>
      </div>
    </main>
  );
}

function SecretRow({
  secret,
  consumers,
  onChange,
  onRemove
}: {
  secret: VaultSecret;
  consumers: string[];
  onChange: (s: VaultSecret) => void;
  onRemove: () => void;
}) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className={clsx("vault-secret-row", styles.secretRow)}>
      <label className={clsx("secret-key", styles.secretField)}>
        <span>name</span>
        <input
          className="text"
          value={secret.key}
          placeholder="SECRET_NAME"
          onChange={(e) => onChange({ ...secret, key: e.target.value })}
        />
      </label>
      <label className={clsx("secret-value", styles.secretField)}>
        <span>sealed value</span>
        <input
          className="text"
          type={revealed ? "text" : "password"}
          value={secret.value}
          placeholder="value"
          onChange={(e) => onChange({ ...secret, value: e.target.value })}
        />
      </label>
      <button
        type="button"
        className={clsx("font-mono secret-reveal", styles.rowButton)}
        onClick={() => setRevealed((v) => !v)}
      >
        {revealed ? "hide" : "reveal"}
      </button>
      <button
        type="button"
        onClick={onRemove}
        className={clsx("secret-remove", styles.rowButton, styles.removeButton)}
        aria-label="Remove secret"
      >
        ×
      </button>
      <span
        className={clsx("font-mono secret-consumers", styles.consumer)}
      >
        {consumers.length > 0 ? (
          <>
            scoped to ·{" "}
            <b>
              {consumers.join(", ")}
            </b>
          </>
        ) : (
          <span>not referenced</span>
        )}
      </span>
    </div>
  );
}

function buildConsumerMap(
  library: LibraryEntry[],
  selections: { [k: string]: { id: string }[] | undefined } | undefined
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!selections) return out;
  const selectedIds = new Set(
    Object.values(selections)
      .flatMap((arr) => arr ?? [])
      .map((sel) => sel.id)
  );
  for (const entry of library) {
    if (!selectedIds.has(entry.id)) continue;
    for (const field of entry.metadata.config_schema) {
      if (field.type !== "secret-ref") continue;
      const key = String(field.default ?? "");
      if (!key) continue;
      if (!out[key]) out[key] = [];
      out[key].push(entry.name);
    }
    // Heuristic: any Fitting that consumes the vault capability is likely to use envs
    // matching its naming pattern. We don't have explicit env declarations in v1, so we
    // leave consumer attribution conservative — only where config_schema declares secret-ref.
  }
  return out;
}

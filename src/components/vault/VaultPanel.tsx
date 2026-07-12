"use client";

import { useMemo, useState } from "react";
import { useAppShell } from "@/components/chrome/AppShell";
import type { LibraryEntry, VaultSecret } from "@/lib/types";

export function VaultPanel() {
  const {
    composition,
    library,
    vaultUnlocked,
    vaultNeedsPassword,
    vaultDevMode,
    secrets,
    setSecrets,
    saveSecrets,
    unlockVault,
    busy
  } = useAppShell();

  const [passphrase, setPassphrase] = useState("");

  const consumers = useMemo(() => buildConsumerMap(library, composition?.selections), [library, composition]);

  return (
    <main>
      <div className="crumbs">
        <b>Vault</b>
      </div>
      <div className="page">
        <div className="head">
          <h1>Vault</h1>
          <p className="ld">
            Encrypted secrets, materialised as <code>.env</code> only between Run and Stop.
          </p>
        </div>

        {vaultDevMode ? (
          <div className="banner alarm">
            <span className="glyph">!</span>
            <div>
              <h5>Dev mode — vault auto-unlocks</h5>
              <p>
                <code>VAULT_UNLOCKED</code> is set: decrypted with a fixed dev passphrase. Unset it to
                require a real one.
              </p>
            </div>
          </div>
        ) : null}

        {vaultNeedsPassword && !vaultDevMode ? (
          <div className="banner alarm">
            <span className="glyph">!</span>
            <div>
              <h5>No vault password set</h5>
              <p>
                Opens without one for bootstrap; the file stays plain on disk until you set a password.
              </p>
            </div>
          </div>
        ) : null}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))",
            gap: 22,
            alignItems: "start"
          }}
        >
          <section style={{ border: "1px solid var(--rule)", background: "white", padding: "22px 24px" }}>
            <h3 className="font-display" style={{ fontWeight: 600, fontSize: 18, margin: "0 0 4px" }}>
              {vaultNeedsPassword ? "Set a vault password" : vaultUnlocked ? "Vault unlocked" : "Unlock vault"}
            </h3>
            <p style={{ color: "var(--mute)", fontSize: 12.5, margin: "0 0 16px" }}>
              {vaultNeedsPassword
                ? "Never stored; you re-enter it on app start."
                : vaultUnlocked
                ? "Decrypted in memory until Stop."
                : "Enter the passphrase to unlock."}
            </p>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                className="text"
                type="password"
                placeholder={vaultNeedsPassword ? "New passphrase" : "Passphrase"}
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    void unlockVault(passphrase);
                  }
                }}
              />
              <button
                className="btn primary"
                disabled={busy === "vault"}
                onClick={() => void unlockVault(passphrase)}
              >
                {vaultNeedsPassword ? "Set" : vaultUnlocked ? "Unlocked" : "Unlock"}
              </button>
            </div>
            <div
              style={{
                marginTop: 16,
                paddingTop: 16,
                borderTop: "1px solid var(--rule)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
                fontSize: 11.5,
                color: "var(--mute)"
              }}
            >
              <span>vault state</span>
              <span>
                {vaultNeedsPassword ? (
                  <>
                    open ·{" "}
                    <b style={{ color: "var(--alarm)", fontFamily: "var(--font-sans), Inter, sans-serif", fontWeight: 600 }}>
                      no password
                    </b>
                  </>
                ) : vaultUnlocked ? (
                  <b style={{ color: "var(--sage)", fontFamily: "var(--font-sans), Inter, sans-serif", fontWeight: 600 }}>
                    unlocked
                  </b>
                ) : (
                  <b style={{ color: "var(--brass)", fontFamily: "var(--font-sans), Inter, sans-serif", fontWeight: 600 }}>
                    locked
                  </b>
                )}
              </span>
            </div>
          </section>

          <section style={{ border: "1px solid var(--rule)", background: "white" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "14px 18px",
                borderBottom: "1px solid var(--rule)"
              }}
            >
              <h3 className="font-display" style={{ fontWeight: 600, fontSize: 18, margin: 0, letterSpacing: "-0.005em" }}>
                Stored secrets · {secrets.length}
              </h3>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  className="btn small ghost"
                  disabled={!vaultUnlocked || vaultNeedsPassword}
                  onClick={() => setSecrets([...secrets, { key: "", value: "" }])}
                >
                  + Add
                </button>
                <button
                  className="btn small ghost"
                  disabled={!vaultUnlocked || vaultNeedsPassword || busy === "secrets"}
                  onClick={() => void saveSecrets()}
                >
                  Save
                </button>
              </div>
            </div>

            {!vaultUnlocked || vaultNeedsPassword ? (
              <div style={{ padding: 28, color: "var(--mute)", fontSize: 13, textAlign: "center" }}>
                {vaultNeedsPassword ? "Set a password before storing secrets." : "Locked — unlock to view secrets."}
              </div>
            ) : secrets.length === 0 ? (
              <div style={{ padding: 28, color: "var(--mute)", fontSize: 13, textAlign: "center" }}>
                No secrets yet. Add one — it materialises as <code>.env</code> on Run.
              </div>
            ) : (
              secrets.map((secret, index) => (
                <SecretRow
                  key={index}
                  secret={secret}
                  consumers={consumers[secret.key] ?? []}
                  onChange={(next) =>
                    setSecrets(secrets.map((s, i) => (i === index ? next : s)))
                  }
                  onRemove={() => setSecrets(secrets.filter((_, i) => i !== index))}
                />
              ))
            )}
          </section>
        </div>

        <h2
          className="font-display"
          style={{
            fontWeight: 600,
            fontSize: 22,
            letterSpacing: "-0.008em",
            margin: "40px 0 12px"
          }}
        >
          Where secrets live
        </h2>
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
                <code>data/vault.json</code> · AES-256-GCM · 0600
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
              <td>nowhere · localhost-only · no auth</td>
              <td>n/a</td>
            </tr>
          </tbody>
        </table>
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
    <div className="vault-secret-row">
      <input
        className="text secret-key"
        style={{ fontFamily: "var(--font-mono), 'JetBrains Mono', monospace", fontSize: 12, fontWeight: 500 }}
        value={secret.key}
        placeholder="KEY"
        onChange={(e) => onChange({ ...secret, key: e.target.value })}
      />
      <input
        className="text secret-value"
        type={revealed ? "text" : "password"}
        style={{ fontFamily: "var(--font-mono), 'JetBrains Mono', monospace", fontSize: 12 }}
        value={secret.value}
        placeholder="value"
        onChange={(e) => onChange({ ...secret, value: e.target.value })}
      />
      <button
        type="button"
        className="font-mono secret-reveal"
        style={{
          fontSize: 10.5,
          border: "1px solid var(--rule)",
          padding: "4px 8px",
          background: "var(--paper)",
          cursor: "pointer",
          color: "var(--mute)"
        }}
        onClick={() => setRevealed((v) => !v)}
      >
        {revealed ? "hide" : "reveal"}
      </button>
      <button
        type="button"
        onClick={onRemove}
        className="secret-remove"
        style={{
          background: "transparent",
          border: "1px solid var(--rule)",
          padding: "4px 8px",
          cursor: "pointer",
          color: "var(--mute)",
          fontSize: 11
        }}
        aria-label="Remove secret"
      >
        ×
      </button>
      <span
        className="font-mono secret-consumers"
        style={{
          fontSize: 10.5,
          color: "var(--mute)",
          letterSpacing: "0.04em",
          whiteSpace: "nowrap"
        }}
      >
        {consumers.length > 0 ? (
          <>
            consumed by ·{" "}
            <b style={{ color: "var(--ink)", fontFamily: "var(--font-sans), Inter, sans-serif", fontWeight: 500, fontSize: 11.5 }}>
              {consumers.join(", ")}
            </b>
          </>
        ) : (
          <span style={{ opacity: 0.6 }}>not referenced</span>
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

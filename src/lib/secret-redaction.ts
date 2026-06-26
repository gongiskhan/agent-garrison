// JIT value redaction. The vault delivers a secret into exactly the process that
// needs it; this masks the secret's VALUE wherever text is persisted or surfaced
// (a process log, an automation run record, an api_call response). spawn.ts
// already redacts env KEYS by name pattern — this is the complementary VALUE
// redaction the brief calls for ("auto-redact values in stdout/stderr/run-records").

export const REDACTED = "***REDACTED***";

// Mask every occurrence of each secret value in `text`. The caller passes only
// KNOWN secret values (vault secrets + OAuth tokens), so every non-empty value is
// masked regardless of length — the "secret values never in logs" guarantee is
// absolute, even for a short value. (A degenerate 1-2 char secret will mask its
// every occurrence in output; that is the user's choice and security wins over
// log readability.)
export function redactSecretValues(text: string, values: readonly string[]): string {
  if (!text) return text;
  let out = text;
  // Longest-first so a value that contains a shorter one is masked whole.
  const sorted = [...new Set(values)].filter((v) => v.length >= 1).sort((a, b) => b.length - a.length);
  for (const value of sorted) {
    if (out.includes(value)) {
      out = out.split(value).join(REDACTED);
    }
  }
  return out;
}

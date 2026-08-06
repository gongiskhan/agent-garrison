import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write";
import { AUTHORED_SECTION_DEFAULTS } from "./orchestrator-authored-defaults";

export const AUTHORED_IDENTITY_REL = ".garrison/orchestrator-authored.json";
export const LEGACY_IDENTITY_SOURCE_REL = ".garrison/prompts/soul.md";

export const LEGACY_SHIPPED_IDENTITY = [
  "# Agent Garrison Soul",
  "",
  "You are called **Verity**. When asked your name, identify yourself as Verity.",
  "",
  "Your character:",
  "",
  "- Direct and transparent. Prefer inspectable steps over hidden behavior.",
  "- Local-first and dogfood-oriented; you live on the user's machine, not in the cloud.",
  "- You do not perform enthusiasm and do not over-apologize.",
  "- You push back kindly when it matters — when a request looks like it'll cause harm, waste effort, or rest on a wrong premise.",
  "- You keep the user informed without theatrics."
].join("\n");

/**
 * Fold a pre-Orchestrator authored identity into the canonical authored
 * document exactly once. Shipped Verity/sentinel files are product defaults,
 * not user overrides, so they are deliberately discarded rather than revived.
 * A custom legacy source is persisted into the canonical authored document
 * before the old file is removed. A malformed authored document is the sole
 * fail-closed case: the legacy source stays in place until the user repairs it.
 */
export async function migrateLegacyIdentityOverride(
  compositionDir: string,
  opts: { throwOnMalformed?: boolean } = {}
): Promise<{ document: Record<string, unknown>; migrated: boolean; malformed: boolean }> {
  const target = path.join(compositionDir, AUTHORED_IDENTITY_REL);
  let document: Record<string, unknown> = {};
  let authoredRaw: string | null = null;
  try {
    authoredRaw = await fs.readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (opts.throwOnMalformed) throw error;
      return { document, migrated: false, malformed: true };
    }
  }
  if (authoredRaw !== null) {
    try {
      const candidate = JSON.parse(authoredRaw) as unknown;
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new Error("authored Orchestrator document must be a JSON object");
      }
      document = candidate as Record<string, unknown>;
    } catch (error) {
      if (opts.throwOnMalformed) {
        throw new Error(`cannot migrate legacy identity: ${target} is malformed (${error instanceof Error ? error.message : String(error)})`);
      }
      // Never overwrite a malformed authored document. Returning defaults is
      // safer than destroying text the user must repair explicitly.
      return { document: {}, migrated: false, malformed: true };
    }
  }

  let migrated = false;
  const legacySection = document["identity-handoff"];
  if (
    !(typeof document.identity === "string" && document.identity.trim()) &&
    typeof legacySection === "string" &&
    legacySection.trim()
  ) {
    document.identity = legacySection.trim();
    delete document["identity-handoff"];
    migrated = true;
  }

  const legacyPath = path.join(compositionDir, LEGACY_IDENTITY_SOURCE_REL);
  let retireLegacy = false;
  try {
    const soul = await fs.readFile(legacyPath, "utf8");
    const trimmed = soul.trim();
    const shippedLegacy = trimmed === LEGACY_SHIPPED_IDENTITY;
    const retiredSentinel = soul.includes("Identity is authored under Orchestrator");
    retireLegacy = !trimmed || shippedLegacy || retiredSentinel;

    if (trimmed && !shippedLegacy && !retiredSentinel) {
      if (!(typeof document.identity === "string" && document.identity.trim())) {
        const appended = trimmed.startsWith(LEGACY_SHIPPED_IDENTITY)
          ? trimmed.slice(LEGACY_SHIPPED_IDENTITY.length).trim()
          : "";
        if (appended) {
          document.identity = `${AUTHORED_SECTION_DEFAULTS.identity.content}\n\n## Migrated personal additions\n\n${appended}`;
        } else if (trimmed.includes("# Agent Garrison Soul") && trimmed.includes("You are called **Verity**")) {
          const preserved = trimmed
            .replace(/^# Agent Garrison Soul\s*/i, "")
            .replace(/You are called \*\*Verity\*\*\. When asked your name, identify yourself as Verity\.\s*/i, "")
            .replace(/\bVerity\b/g, "Gary")
            .trim();
          document.identity = `${AUTHORED_SECTION_DEFAULTS.identity.content}\n\n## Migrated legacy customization\n\n${preserved}`;
        } else {
          document.identity = trimmed;
        }
      } else {
        // The canonical Identity already wins. Keep the displaced authored text
        // as non-runtime provenance rather than either dropping it or injecting
        // a second identity into the prompt. Unknown authored-document keys are
        // deliberately ignored by readAuthoredOverrides.
        const archiveKey = "retired-legacy-identity";
        const prior = typeof document[archiveKey] === "string" ? String(document[archiveKey]).trim() : "";
        if (!prior.includes(trimmed)) {
          document[archiveKey] = prior ? `${prior}\n\n---\n\n${trimmed}` : trimmed;
        }
      }
      migrated = true;
      retireLegacy = true;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (opts.throwOnMalformed) throw error;
      return { document, migrated, malformed: true };
    }
    // No legacy identity is the normal v4 state.
  }

  if (migrated) {
    await writeFileAtomic(target, `${JSON.stringify(document, null, 2)}\n`);
  }
  if (retireLegacy) {
    await fs.unlink(legacyPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  return { document, migrated, malformed: false };
}

import fs from "node:fs/promises";
import path from "node:path";
import { ROOT_DIR } from "./paths";
import { CasMismatchError, writeFileAtomic } from "./atomic-write";

const SEED_ROUTING_PATH = path.join(
  ROOT_DIR,
  "fittings/seed/orchestrator/config/routing.seed.json"
);

function compositionRoutingSeeds(compositionDir: string): string[] {
  return [
    path.join(compositionDir, "routing.seed.json"),
    // Back-compat for the first composition-specific policy, committed before
    // the generic routing.seed.json convention existed.
    path.join(compositionDir, "routing.glm-only.json")
  ];
}

/**
 * Materialize a committed composition-specific routing policy exactly once.
 * The local .garrison file remains the source of truth after creation: an
 * existing file is never rewritten, even when the committed seed changes.
 */
export async function ensureCompositionRoutingPolicy(
  compositionDir: string
): Promise<string | null> {
  const target = path.join(compositionDir, ".garrison", "routing.json");
  try {
    await fs.access(target);
    return target;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Look for an explicit seed owned by this composition. Most compositions
    // intentionally inherit the global policy and therefore have no seed.
  }

  for (const seed of compositionRoutingSeeds(compositionDir)) {
    let content: string;
    try {
      content = await fs.readFile(seed, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    try {
      const parsed = JSON.parse(content) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("policy must be a JSON object");
      }
    } catch (error) {
      throw new Error(
        `composition routing seed ${seed} is invalid (${error instanceof Error ? error.message : String(error)})`
      );
    }
    try {
      await writeFileAtomic(target, content, { cas: { priorContent: null } });
    } catch (error) {
      // Another request may have seeded or authored the local policy between
      // access() and the CAS. Its complete file wins; never overwrite it.
      if (!(error instanceof CasMismatchError)) throw error;
      await fs.access(target);
    }
    return target;
  }
  return null;
}

export interface RoutingPolicySource {
  path: string;
  text: string;
}

/**
 * Read the effective policy without changing the composition. A committed
 * composition seed participates in reads immediately, but only a mutating
 * launch/write seam materializes it into .garrison/routing.json.
 */
export async function readRoutingPolicySource(
  compositionDir: string
): Promise<RoutingPolicySource> {
  const scoped = path.join(compositionDir, ".garrison", "routing.json");
  try {
    return { path: scoped, text: await fs.readFile(scoped, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const seed of compositionRoutingSeeds(compositionDir)) {
    try {
      return { path: seed, text: await fs.readFile(seed, "utf8") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { path: SEED_ROUTING_PATH, text: await fs.readFile(SEED_ROUTING_PATH, "utf8") };
}

// Read the explicit primary from the same composition-seeded/global policy as
// every runner seam. A blank/missing field is null (historical default); an
// unreadable or invalid policy throws so a GLM composition cannot silently
// downgrade to Claude because its local policy is corrupt.
export async function resolvePrimaryFromPolicy(compositionDir: string): Promise<string | null> {
  const source = await readRoutingPolicySource(compositionDir);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.text) as unknown;
  } catch (error) {
    throw new Error(
      `routing policy ${source.path} is invalid JSON (${error instanceof Error ? error.message : String(error)})`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`routing policy ${source.path} is invalid (policy must be a JSON object)`);
  }
  const policy = parsed as { primaryRuntime?: unknown };
  const raw = typeof policy.primaryRuntime === "string" ? policy.primaryRuntime.trim() : "";
  return raw.length ? raw : null;
}

// Persist the primary in the composition-scoped routing source of truth. The
// first write starts from the complete seed policy; subsequent writes preserve
// every routing field. CAS prevents a simultaneous Composer autosave from being
// silently overwritten by the Muster button.
export async function writePrimaryRuntimeToPolicy(
  compositionDir: string,
  fittingId: string
): Promise<string> {
  const desired = fittingId.trim();
  if (!desired) throw new Error("primary runtime id is required");
  const target = path.join(compositionDir, ".garrison", "routing.json");

  // If this composition owns an explicit seed (GLM is the first), establish it
  // before editing so changing the primary cannot accidentally import the
  // stock Claude target matrix into a composition-specific policy.
  await ensureCompositionRoutingPolicy(compositionDir);

  let priorContent: string | null = null;
  let sourceContent: string;
  try {
    priorContent = await fs.readFile(target, "utf8");
    sourceContent = priorContent;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    sourceContent = (await readRoutingPolicySource(compositionDir)).text;
  }

  let config: Record<string, unknown>;
  try {
    const parsed = JSON.parse(sourceContent) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("routing policy must be a JSON object");
    }
    config = parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `cannot update primary runtime: routing policy is invalid JSON (${error instanceof Error ? error.message : String(error)})`
    );
  }

  config.primaryRuntime = desired;
  await writeFileAtomic(target, `${JSON.stringify(config, null, 2)}\n`, {
    cas: { priorContent }
  });
  return target;
}

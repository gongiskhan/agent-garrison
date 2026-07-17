import fs from "node:fs/promises";
import path from "node:path";
import { ROOT_DIR } from "./paths";
import { writeFileAtomic } from "./atomic-write";

const SEED_ROUTING_PATH = path.join(
  ROOT_DIR,
  "fittings/seed/orchestrator/config/routing.seed.json"
);

// Read the explicit primary from composition policy, falling back to the seed
// policy exactly as the runner does. An unreadable/absent value is null so the
// caller retains the historical Claude Code default semantics.
export async function resolvePrimaryFromPolicy(compositionDir: string): Promise<string | null> {
  const scoped = path.join(compositionDir, ".garrison", "routing.json");
  for (const candidate of [scoped, SEED_ROUTING_PATH]) {
    try {
      const parsed = JSON.parse(await fs.readFile(candidate, "utf8")) as { primaryRuntime?: unknown };
      const raw = typeof parsed.primaryRuntime === "string" ? parsed.primaryRuntime.trim() : "";
      return raw.length ? raw : null;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
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

  let priorContent: string | null = null;
  let sourceContent: string;
  try {
    priorContent = await fs.readFile(target, "utf8");
    sourceContent = priorContent;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    sourceContent = await fs.readFile(SEED_ROUTING_PATH, "utf8");
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

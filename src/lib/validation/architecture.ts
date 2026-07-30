import path from "node:path";
import { parseGarrisonMetadata } from "../metadata";
import { readYamlFile } from "../yaml";
import type { GarrisonMetadata } from "../types";
import type { ValidationCheck } from "./index";

interface RawManifest {
  name?: string;
  "x-garrison"?: unknown;
}

export interface ArchitectureCheckResult {
  check: ValidationCheck;
  metadata: GarrisonMetadata | null;
  fittingId: string | null;
}

export async function runArchitectureCheck(fittingPath: string): Promise<ArchitectureCheckResult> {
  const manifestPath = path.join(fittingPath, "apm.yml");
  const notes: string[] = [];
  const errors: string[] = [];
  let manifest: RawManifest | null = null;

  try {
    manifest = await readYamlFile<RawManifest>(manifestPath);
  } catch (error) {
    errors.push(`failed to read apm.yml: ${describe(error)}`);
    return {
      check: { name: "architecture", passed: false, notes, errors },
      metadata: null,
      fittingId: null
    };
  }

  if (!manifest) {
    errors.push("apm.yml is missing or empty");
    return {
      check: { name: "architecture", passed: false, notes, errors },
      metadata: null,
      fittingId: null
    };
  }

  const fittingId = manifest.name ?? null;
  let metadata: GarrisonMetadata | null = null;
  try {
    metadata = parseGarrisonMetadata(manifest["x-garrison"]);
    notes.push(`parsed faculty ${metadata.faculty} as ${metadata.component_shape}`);
    if (metadata.provides.length > 0) {
      notes.push(`provides ${metadata.provides.length} capability/ies`);
    }
    if (metadata.consumes.length > 0) {
      notes.push(`consumes ${metadata.consumes.length} capability/ies`);
    }
    // Every Fitting has a view (2026-07-29 fittings/views refit): either an
    // own-port UI or at least one declared ui.views[] entry (a shared
    // garrison:* view counts). A fitting without one is invisible in the
    // sidebar Fittings group — that is an authoring error, not a style choice.
    const viewCount = metadata.ui?.views.length ?? 0;
    if (metadata.own_port === true) {
      notes.push("view: own-port UI");
    } else if (viewCount > 0) {
      notes.push(`view: ${viewCount} declared view(s)`);
    } else {
      errors.push(
        "no view: every Fitting must declare x-garrison.ui.views (a shared garrison:* entry is fine) or own_port: true — see docs/UI-FITTINGS.md"
      );
    }
  } catch (error) {
    errors.push(`x-garrison metadata invalid: ${describe(error)}`);
  }

  return {
    check: {
      name: "architecture",
      passed: errors.length === 0,
      notes,
      errors
    },
    metadata,
    fittingId
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

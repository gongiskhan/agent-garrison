import type { GarrisonMetadata } from "../types";
import type { ValidationCheck, ValidationContext } from "./index";

export async function runQualityCheck(
  _context: ValidationContext,
  metadata: GarrisonMetadata | null
): Promise<ValidationCheck> {
  const notes: string[] = [];
  const errors: string[] = [];

  if (!metadata) {
    errors.push("metadata unavailable; skipping quality checks");
    return { name: "quality", passed: false, notes, errors };
  }

  for (const field of metadata.config_schema) {
    if (!field.description || field.description.trim().length === 0) {
      errors.push(`config_schema field ${field.key} has no description`);
    }
  }

  if (metadata.summary !== undefined && metadata.summary.trim().length === 0) {
    errors.push("summary is present but empty");
  }

  if (errors.length === 0) {
    notes.push("config schema fields documented; summary is well-formed if present");
  }

  return {
    name: "quality",
    passed: errors.length === 0,
    notes,
    errors
  };
}

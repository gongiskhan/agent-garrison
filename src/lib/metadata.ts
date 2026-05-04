import { z } from "zod";
import {
  capabilityKinds,
  facultyIds,
  fittingShapes,
  type FacultyId,
  type GarrisonMetadata
} from "./types";
import { getFaculty } from "./faculties";

const configFieldSchema = z
  .object({
    key: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
    type: z.enum(["string", "integer", "number", "boolean", "select", "path", "secret-ref"]),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    description: z.string().min(1),
    required: z.boolean().optional(),
    options: z.array(z.string()).optional()
  })
  .superRefine((field, context) => {
    if (field.type === "select" && (!field.options || field.options.length === 0)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "select config fields require options"
      });
    }
  });

const capabilityKindSchema = z.enum(capabilityKinds, {
  errorMap: (_issue, context) => ({
    message: `unknown capability kind ${JSON.stringify(context.data)}; expected one of ${capabilityKinds.join(", ")}`
  })
});

const provisionSchema = z.object({
  kind: capabilityKindSchema,
  name: z.string().min(1, "capability provision name is required")
});

const consumptionSchema = z.object({
  kind: capabilityKindSchema,
  name: z.string().min(1).optional(),
  cardinality: z.enum(["one", "optional-one", "any"]).optional()
});

export const garrisonMetadataSchema = z.object({
  faculty: z.enum(facultyIds),
  cardinality_hint: z.enum(["single", "multi"]),
  component_shape: z.enum(fittingShapes),
  platforms: z.array(z.string()).min(1),
  summary: z.string().optional(),
  config_schema: z.array(configFieldSchema).default([]),
  provides: z.array(provisionSchema).default([]),
  consumes: z.array(consumptionSchema).default([]),
  verify: z.object({
    command: z.string().min(1),
    expect: z.string().min(1),
    timeout_ms: z.number().int().positive().default(10000)
  }),
  ui: z
    .object({
      extension: z.string().min(1)
    })
    .optional(),
  tasks: z
    .object({
      source: z.string().min(1),
      truth_file: z.string().min(1)
    })
    .optional()
});

export function parseGarrisonMetadata(input: unknown): GarrisonMetadata {
  const normalized = normalizeDeprecations(input);
  const metadata = garrisonMetadataSchema.parse(normalized);
  validateFacultyCompatibility(metadata);
  return metadata;
}

function normalizeDeprecations(input: unknown): unknown {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  let record = { ...(input as Record<string, unknown>) };

  if (!("faculty" in record) && "primitive" in record) {
    const { primitive, ...rest } = record;
    console.warn(
      "[garrison] x-garrison.primitive is deprecated; rename to x-garrison.faculty"
    );
    record = { faculty: primitive, ...rest };
  }

  if (record.faculty === "testing-framework") {
    console.warn(
      "[garrison] faculty \"testing-framework\" is deprecated; rename to \"skills\""
    );
    record = { ...record, faculty: "skills" };
  }

  return record;
}

export function validateFacultyCompatibility(metadata: GarrisonMetadata): void {
  const faculty = getFaculty(metadata.faculty);
  if (metadata.cardinality_hint !== faculty.cardinality) {
    throw new Error(
      `${metadata.faculty} declares ${metadata.cardinality_hint}, expected ${faculty.cardinality}`
    );
  }
  if (!faculty.shapes.includes(metadata.component_shape)) {
    throw new Error(
      `${metadata.component_shape} is not accepted by faculty ${metadata.faculty}`
    );
  }
  if (metadata.tasks && metadata.faculty !== "data-sources") {
    throw new Error("Only data source fittings may declare derived task backing");
  }
}

export function validateSelection(
  facultyId: FacultyId,
  selectedCount: number,
  metadata: GarrisonMetadata[]
): void {
  const faculty = getFaculty(facultyId);
  if (faculty.cardinality === "single" && selectedCount > 1) {
    throw new Error(`${faculty.name} accepts one fitting`);
  }
  for (const entry of metadata) {
    if (entry.faculty !== facultyId) {
      throw new Error(`${entry.faculty} fitting cannot be selected for ${facultyId}`);
    }
    validateFacultyCompatibility(entry);
    if (!entry.platforms.includes("all") && !entry.platforms.includes("claude-code")) {
      throw new Error(`${facultyId} fitting does not support claude-code`);
    }
  }
}

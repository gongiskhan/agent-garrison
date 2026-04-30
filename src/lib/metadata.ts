import { z } from "zod";
import { componentShapes, primitiveIds, type GarrisonMetadata, type PrimitiveId } from "./types";
import { getPrimitive } from "./primitives";

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

export const garrisonMetadataSchema = z.object({
  primitive: z.enum(primitiveIds),
  cardinality_hint: z.enum(["single", "multi"]),
  component_shape: z.enum(componentShapes),
  platforms: z.array(z.string()).min(1),
  summary: z.string().optional(),
  config_schema: z.array(configFieldSchema).default([]),
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
  const metadata = garrisonMetadataSchema.parse(input);
  validatePrimitiveCompatibility(metadata);
  return metadata;
}

export function validatePrimitiveCompatibility(metadata: GarrisonMetadata): void {
  const primitive = getPrimitive(metadata.primitive);
  if (metadata.cardinality_hint !== primitive.cardinality) {
    throw new Error(
      `${metadata.primitive} declares ${metadata.cardinality_hint}, expected ${primitive.cardinality}`
    );
  }
  if (!primitive.shapes.includes(metadata.component_shape)) {
    throw new Error(
      `${metadata.component_shape} is not accepted by primitive ${metadata.primitive}`
    );
  }
  if (metadata.tasks && metadata.primitive !== "data-sources") {
    throw new Error("Only data source components may declare derived task backing");
  }
}

export function validateSelection(
  primitiveId: PrimitiveId,
  selectedCount: number,
  metadata: GarrisonMetadata[]
): void {
  const primitive = getPrimitive(primitiveId);
  if (primitive.cardinality === "single" && selectedCount > 1) {
    throw new Error(`${primitive.name} accepts one component`);
  }
  for (const entry of metadata) {
    if (entry.primitive !== primitiveId) {
      throw new Error(`${entry.primitive} component cannot be selected for ${primitiveId}`);
    }
    validatePrimitiveCompatibility(entry);
    if (!entry.platforms.includes("all") && !entry.platforms.includes("claude-code")) {
      throw new Error(`${primitiveId} component does not support claude-code`);
    }
  }
}

import { z } from "zod";
import {
  capabilityKinds,
  dutyEfforts,
  facultyIds,
  fittingShapes,
  uiPlacements,
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

// for_consumers is injected verbatim into the assembled system prompt at
// runtime. The 8 KB cap keeps a single Fitting from drowning the
// Orchestrator's context window with usage docs.
const FOR_CONSUMERS_MAX_BYTES = 8 * 1024;

// One ordered setup step. Exported so the Setup Instructions editor's write path
// (promoted-fittings.ts validateSetupSteps) validates against the SAME schema the
// apm.yml parser uses — one source of truth for "what a valid setup step is".
export const setupStepSchema = z.object({
  command: z.string().trim().min(1),
  // Informational metadata (the runner does not branch on it); defaults to true
  // since most setup steps (installs, builds) are safe to re-run.
  idempotent: z.boolean().default(true),
  timeout_ms: z.number().int().positive().optional(),
  // Optional human-readable label shown in the Setup Instructions editor.
  label: z.string().trim().min(1).optional()
});

const connectorActionSchema = z.object({
  name: z.string().min(1),
  args: z.array(z.string()).optional(),
  mutates: z.boolean().optional(),
  description: z.string().optional()
});

const connectorTriggerSchema = z.object({
  type: z.enum(["webhook", "listener"]),
  event: z.string().optional(),
  cron: z.string().optional(),
  description: z.string().optional()
});

// The connector sub-block (kind:connector Fittings). Auth names HOW the
// credential is obtained; the credential itself is sealed in the Vault, never
// inlined here.
const connectorOAuthSchema = z
  .object({
    auth_url: z.string(),
    token_url: z.string(),
    scopes: z.array(z.string()).default([]),
    client_id_secret: z.string(),
    client_secret_secret: z.string()
  })
  .transform((o) => ({
    authUrl: o.auth_url,
    tokenUrl: o.token_url,
    scopes: o.scopes,
    clientIdSecret: o.client_id_secret,
    clientSecretSecret: o.client_secret_secret
  }));

const connectorSpecSchema = z.object({
  auth: z.enum(["oauth2", "api_key", "none"]),
  actions: z.array(connectorActionSchema).default([]),
  triggers: z.array(connectorTriggerSchema).optional(),
  oauth: connectorOAuthSchema.optional()
});

// Duty sub-block (MARATHON-V3 D2/D3/D4): one spec per kind:duty provision
// (provision name === duty id). A level is leaf (cell) XOR composite
// (sequence) — declaring both or neither is a parse error. Levels are stored
// flat; no inheritance in the data model.
const dutyLevelCellSchema = z
  .object({
    skill: z.string().min(1).optional(),
    target: z.string().min(1).optional(),
    effort: z.enum(dutyEfforts).optional()
  })
  .strict();

const dutySequenceEntrySchema = z
  .object({
    duty: z.string().min(1),
    level: z.number().int().min(1).optional()
  })
  .strict();

const dutyLevelSchema = z
  .object({
    description: z.string().min(1, "each duty level needs a one-line description"),
    cell: dutyLevelCellSchema.optional(),
    sequence: z.array(dutySequenceEntrySchema).min(1).optional()
  })
  .strict()
  .superRefine((level, ctx) => {
    if ((level.cell === undefined) === (level.sequence === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a duty level is either a cell (leaf) or a sequence (composite) — exactly one"
      });
    }
  });

const dutySchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9-]*$/, "duty id must be kebab-case"),
    title: z.string().min(1),
    description: z.string().min(1),
    levels: z.array(dutyLevelSchema).min(1, "a duty declares at least one level")
  })
  .strict();

// D3 (GARRISON-RUNTIMES-V1): a runtime Fitting declares HOW a provider override
// (base URL / auth credential / model) is applied to its engine — env vars for
// claude-code, a config-file table for codex/gemini. The composer's target
// editor adapts to this declaration; a runtime with no mechanism is still a
// routing target, just without provider overrides. Strict: an unknown key here
// is a manifest bug and fails the parse loudly rather than being dropped.
const providerMechanismSchema = z
  .discriminatedUnion("type", [
    z
      .object({
        type: z.literal("env"),
        base_url_env: z.string().min(1).optional(),
        auth_env: z.string().min(1).optional(),
        model_arg: z.string().min(1).optional(),
        model_env: z.string().min(1).optional(),
        notes: z.string().optional()
      })
      .strict(),
    z
      .object({
        type: z.literal("config-file"),
        config_file: z
          .string({ required_error: "provider_mechanism type 'config-file' requires config_file and config_format" })
          .min(1),
        config_format: z.enum(["json", "toml"], {
          required_error: "provider_mechanism type 'config-file' requires config_file and config_format"
        }),
        config_key: z.string().min(1).optional(),
        model_key: z.string().min(1).optional(),
        notes: z.string().optional()
      })
      .strict()
  ])
  .superRefine((m, context) => {
    if (m.type === "env" && !m.base_url_env && !m.auth_env && !m.model_arg && !m.model_env) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "provider_mechanism type 'env' declares none of base_url_env/auth_env/model_arg/model_env — declare at least one or omit the block"
      });
    }
  });

const quartersSettingsFileSchema = z
  .object({
    path: z.string().min(1),
    format: z.enum(["json", "toml"]),
    label: z.string().min(1).optional()
  })
  .strict();

// D5: the Quarters descriptor a runtime Fitting ships. tier "deep" maps to a
// registered deep implementation by id (claude-code today); tier "generic"
// drives the descriptor-rendered generic surface and therefore must say where
// the runtime's native config lives. Strict for the same loudness reason.
const quartersMcpConfigSchema = z
  .object({
    path: z.string().min(1),
    format: z.enum(["json", "toml"]),
    key: z.string().min(1).optional()
  })
  .strict();

const quartersDescriptorIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, "quarters_descriptor id must be kebab-case");

const quartersDescriptorSchema = z.discriminatedUnion("tier", [
  z
    .object({
      tier: z.literal("deep"),
      id: quartersDescriptorIdSchema,
      home_dir: z.string().min(1).optional(),
      settings_files: z.array(quartersSettingsFileSchema).optional(),
      context_file: z.string().min(1).optional(),
      mcp_config: quartersMcpConfigSchema.optional(),
      log_paths: z.array(z.string().min(1)).optional(),
      categories: z.array(z.string().min(1)).optional()
    })
    .strict(),
  z
    .object({
      tier: z.literal("generic"),
      id: quartersDescriptorIdSchema,
      home_dir: z
        .string({
          required_error:
            "quarters_descriptor tier 'generic' requires home_dir (the runtime's native config directory)"
        })
        .min(1),
      settings_files: z.array(quartersSettingsFileSchema).optional(),
      context_file: z.string().min(1).optional(),
      mcp_config: quartersMcpConfigSchema.optional(),
      log_paths: z.array(z.string().min(1)).optional(),
      categories: z.array(z.string().min(1)).optional()
    })
    .strict()
]);

const spawnConfigSchema = z.object({
  preset: z.enum(["claude_code", "none"]).default("claude_code"),
  allowed_tools: z.array(z.string()).optional(),
  disallowed_tools: z.array(z.string()).optional(),
  exclude_dynamic_sections: z.boolean().default(false),
  base_path: z.string().optional(),
  mcp: z.array(z.string()).optional()
});

// WS6 (D8): the in-app TOUR descriptor — a runnable SUBSET of the .walkthrough
// storyboard schema (the same beat/action/assert/selector vocabulary), executed
// DOM-side by the tour engine (src/components/tours) rather than by Playwright.
// The `selector` field uses the SAME mini-language as storyboards; the resolver
// lives in src/lib/tour-selector.ts. A tour ships either inline as
// x-garrison.ui.tours[] or as a tours/*.json file beside the fitting.
const tourActionSchema = z
  .object({
    // The engine performs this on the step's resolved element in DEMO mode.
    // navigate is the exception — it drives the router with `path`, no element.
    type: z.enum(["click", "fill", "select", "navigate"]),
    value: z.string().optional(),
    path: z.string().optional()
  })
  .strict();

const tourAssertSchema = z
  .object({
    selector: z.string().min(1).optional(),
    text: z.string().optional(),
    state: z.enum(["visible", "enabled", "disabled", "checked", "expanded"]).optional(),
    // url gates on the current pathname (startsWith) — the natural assert for a
    // GUIDED step whose action navigates to another route.
    url: z.string().min(1).optional()
  })
  .strict()
  .refine((assert) => Boolean(assert.selector) || Boolean(assert.url), {
    message: "tour assert requires either a selector or a url"
  });

const tourStepSchema = z
  .object({
    id: z.string().min(1),
    caption: z.string().min(1),
    selector: z.string().min(1),
    action: tourActionSchema.optional(),
    assert: tourAssertSchema.optional(),
    spotlight: z.boolean().optional()
  })
  .strict();

export const tourDescriptorSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9-]*$/, "tour name must be kebab-case"),
    title: z.string().min(1),
    route: z.string().min(1),
    // fitting is derived from the owning fitting id when a tour is discovered;
    // authors may omit it in inline/beside-fitting descriptors.
    fitting: z.string().min(1).optional(),
    // Default player when no ?mode= override is present. Absent → guided.
    mode: z.enum(["demo", "guided"]).optional(),
    steps: z.array(tourStepSchema).min(1, "a tour needs at least one step")
  })
  .strict();

export type TourAction = z.infer<typeof tourActionSchema>;
export type TourAssert = z.infer<typeof tourAssertSchema>;
export type TourStep = z.infer<typeof tourStepSchema>;
export type TourDescriptor = z.infer<typeof tourDescriptorSchema>;

export const garrisonMetadataSchema = z.object({
  faculty: z.enum(facultyIds),
  cardinality_hint: z.enum(["single", "multi"]),
  component_shape: z.enum(fittingShapes),
  platforms: z.array(z.string()).min(1),
  summary: z.string().optional(),
  for_consumers: z
    .string()
    .refine(
      (value) => Buffer.byteLength(value, "utf8") <= FOR_CONSUMERS_MAX_BYTES,
      { message: `for_consumers exceeds ${FOR_CONSUMERS_MAX_BYTES} byte cap` }
    )
    .optional(),
  config_schema: z.array(configFieldSchema).default([]),
  provides: z.array(provisionSchema).default([]),
  consumes: z.array(consumptionSchema).default([]),
  // Setup accepts EITHER a single step (back-compat — the historical shape every
  // seed fitting uses) OR an ordered array of steps, and normalises both to an
  // array. Steps run in order and the installer aborts on the first non-zero
  // exit. This is the single source of truth the Setup Instructions editor reads
  // and writes back.
  setup: z
    .union([setupStepSchema, z.array(setupStepSchema).min(1, "setup must contain at least one step")])
    .transform((value) => (Array.isArray(value) ? value : [value]))
    .optional(),
  verify: z.object({
    command: z.string().min(1),
    expect: z.string().min(1),
    timeout_ms: z.number().int().positive().default(10000)
  }),
  ui: z
    .object({
      views: z
        .array(
          z.object({
            id: z
              .string()
              .min(1)
              .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, "view id must be alphanumeric/-/_"),
            placement: z.enum(uiPlacements),
            entry: z.string().min(1),
            route: z.string().min(1),
            chrome: z.enum(["default", "full-bleed"]).optional()
          })
        )
        .min(1, "ui.views must contain at least one view"),
      // WS6: optional in-app tours declared inline on the fitting. Additive —
      // existing manifests without it are unaffected; the tours registry also
      // discovers tours/*.json shipped beside the fitting.
      tours: z.array(tourDescriptorSchema).optional()
    })
    .optional(),
  tasks: z
    .object({
      source: z.string().min(1),
      truth_file: z.string().min(1)
    })
    .optional(),
  spawn: spawnConfigSchema.optional(),
  own_port: z.boolean().optional(),
  default_port: z.number().int().positive().optional(),
  lifecycle: z.enum(["operative-bound", "detached"]).optional(),
  connector: connectorSpecSchema.optional(),
  duties: z.array(dutySchema).optional(),
  secret_scope: z.array(z.string().min(1)).optional(),
  provider_mechanism: providerMechanismSchema.optional(),
  quarters_descriptor: quartersDescriptorSchema.optional()
})
  // Duty cross-field rules live ON the schema (not only in
  // parseGarrisonMetadata) so a direct schema user cannot parse an invalid
  // duty manifest: every kind:duty provision needs a matching duties[] spec
  // (provision name === duty id) and vice versa; no duplicate duty ids on
  // either side. A duty without a spec is undispatchable, a spec without a
  // provision is undiscoverable.
  .superRefine((metadata, ctx) => {
    const provided = metadata.provides.filter((p) => p.kind === "duty").map((p) => p.name);
    const specs = (metadata.duties ?? []).map((d) => d.id);
    for (const name of provided) {
      if (!specs.includes(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["provides"],
          message: `fitting provides duty "${name}" but declares no matching duties[] spec`
        });
      }
    }
    for (const id of specs) {
      if (!provided.includes(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["duties"],
          message: `duties[] declares "${id}" but no provides entry {kind: duty, name: ${id}} exists`
        });
      }
    }
    const dupeSpecs = specs.filter((id, i) => specs.indexOf(id) !== i);
    if (dupeSpecs.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["duties"],
        message: `duplicate duty ids in duties[]: ${[...new Set(dupeSpecs)].join(", ")}`
      });
    }
    const dupeProvisions = provided.filter((name, i) => provided.indexOf(name) !== i);
    if (dupeProvisions.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["provides"],
        message: `duplicate duty provisions: ${[...new Set(dupeProvisions)].join(", ")}`
      });
    }
  });

// Legacy faculty names fold into the role faculties (the Quarters pivot). The
// own-port residue keeps working — its Fittings just declare a role faculty + the
// own_port flag. Parked config-projection faculties (heartbeat/scheduler/skills/…)
// are not aliased; their Fittings are de-listed from the library and never parsed.
// (The `data-sources` alias + `data-source` kind were dropped 2026-06-26 —
// Trello moved to the `trello` connector under the `connectors` faculty.)
export const FACULTY_ALIASES: Record<string, (typeof facultyIds)[number]> = {
  terminal: "sessions",
  // screen-share / browser / outposts split out of sessions into the new
  // `surfaces` role (2026-06-18) — auxiliary own-port live viewers.
  "screen-share": "surfaces",
  "worktree-management": "sessions",
  "session-view": "sessions",
  outposts: "surfaces",
  browser: "surfaces",
  "web-channel": "channels",
  voice: "channels",
  monitor: "observability",
  "testing-framework": "sessions"
};

export function parseGarrisonMetadata(input: unknown): GarrisonMetadata {
  const normalized = normalizeDeprecations(input);
  // Duty cross-field validation rides on the schema itself (superRefine above).
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

  if (typeof record.faculty === "string" && record.faculty in FACULTY_ALIASES) {
    const target = FACULTY_ALIASES[record.faculty];
    console.warn(
      `[garrison] faculty "${record.faculty}" is deprecated; folded into role "${target}"`
    );
    record = { ...record, faculty: target };
  }

  // UI contract v1 → v2: rewrite { ui: { extension } } into a single
  // faculty-tab view so every consumer downstream sees only the v2 shape.
  // Same pattern as the primitive/testing-framework rewrites above.
  if (record.ui && typeof record.ui === "object" && !Array.isArray(record.ui)) {
    const ui = record.ui as Record<string, unknown>;
    if (typeof ui.extension === "string" && !("views" in ui)) {
      console.warn(
        "[garrison] x-garrison.ui.extension is deprecated; declare x-garrison.ui.views instead"
      );
      record = {
        ...record,
        ui: {
          views: [
            {
              id: "main",
              placement: "faculty-tab",
              entry: ui.extension,
              route: "/"
            }
          ]
        }
      };
    }
  }

  return record;
}

export function validateFacultyCompatibility(metadata: GarrisonMetadata): void {
  const faculty = getFaculty(metadata.faculty);
  // A multi role (e.g. sessions) legitimately holds several single-instance
  // own-port Fittings, so cardinality_hint need only be <= the faculty: a
  // multi-cardinality Fitting cannot occupy a single-cardinality role.
  if (metadata.cardinality_hint === "multi" && faculty.cardinality === "single") {
    throw new Error(
      `${metadata.faculty} is a single-Fitting role, but ${metadata.cardinality_hint} was declared`
    );
  }
  if (!faculty.shapes.includes(metadata.component_shape)) {
    throw new Error(
      `${metadata.component_shape} is not accepted by faculty ${metadata.faculty}`
    );
  }
  // (The data-sources faculty — the former home of derived task backing — was
  // folded out in the Quarters pivot; `tasks` is no longer faculty-restricted.)
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

// Ambient types for the Automations engine's plain-JS (.mjs) lib modules so the
// TS tests can import them under tsc --noEmit without implicit-any errors.
declare module "*/automations/lib/types.mjs" {
  export const STEP_TYPES: string[];
  export const TRIGGER_TYPES: string[];
  export function isStepType(t: string): boolean;
  export function validateAutomation(auto: unknown): boolean;
  export function normalizeAutomation(auto: any, opts?: { now?: string }): any;
}
declare module "*/automations/lib/store.mjs" {
  export function automationsDir(): string;
  export function listAutomations(): Promise<any[]>;
  export function getAutomation(id: string): Promise<any | null>;
  export function saveAutomation(auto: any, opts?: { now?: string }): Promise<any>;
  export function deleteAutomation(id: string): Promise<boolean>;
  export function saveBrief(slug: string, markdown: string): Promise<string>;
  export function saveRun(record: any): Promise<any>;
  export function getRun(runId: string): Promise<any | null>;
  export function listRuns(automationId?: string): Promise<any[]>;
  export function writeStepEvidence(runId: string, stepIndex: number, base64Jpeg: string): Promise<string>;
  export function saveMatrixRun(record: any): Promise<any>;
  export function getMatrixRun(matrixId: string): Promise<any | null>;
}
declare module "*/automations/lib/template-vars.mjs" {
  export function interpolate(template: string, scope: any): string;
  export function interpolateDeep(value: any, scope: any): any;
}
declare module "*/automations/lib/engine.mjs" {
  export function runAutomation(opts: any): Promise<any>;
  export function runAutomationMatrix(opts: any): Promise<any>;
  export function getAutomation(id: string): Promise<any | null>;
}
declare module "*/automations/lib/assertions.mjs" {
  export const ASSERTION_KINDS: string[];
  export function isAssertionKind(kind: string): boolean;
  export function needsRemoteProbe(kind: string): boolean;
  export function compareCount(actual: number, op: string, value: number): boolean;
  export function evaluateTextContains(assertion: any, observation: any): boolean;
  export function evaluateUrlMatches(assertion: any, observation: any): boolean;
}
declare module "*/automations/lib/fingerprint.mjs" {
  export function fingerprintFromParts(parts: any): any;
  export function fingerprintKey(fp: any): string;
  export function shapeSketchFromCounts(counts: Record<string, number>): string;
}
declare module "*/automations/lib/cache.mjs" {
  export function lookupActionCache(automationId: string, stepId: string, fingerprint: any): Promise<any | null>;
  export function writeActionCache(input: any): Promise<any>;
  export function evictAction(automationId: string, stepId: string, fingerprint: any): Promise<boolean>;
  export function lookupAssertionCache(automationId: string, stepId: string, fingerprint: any): Promise<any | null>;
  export function writeAssertionCache(input: any): Promise<any>;
}
declare module "*/automations/lib/browser-orchestrator.mjs" {
  export function runBrowserStep(opts: { automationId: string; step: any; deps: any; bypassCache?: boolean }): Promise<any>;
}
declare module "*/automations/lib/discuss.mjs" {
  export function slugify(name: string): string;
  export function freshAutomationSlug(): string;
  export function buildAutomationKickoff(opts?: any): string;
  export function buildAutomationDiscussUrl(opts?: any): string;
  export function buildDiscussParams(opts?: any): { mode: string; context: string; kickoff: string; thread: string; title?: string };
}
declare module "*/automations/lib/command-shape.mjs" {
  export function computeCommandShape(argv: string[]): string;
  export function shapeForStep(step: any): string;
  export function isShapeApproved(shape: string): Promise<boolean>;
  export function approveShape(shape: string): Promise<void>;
}
declare module "*/automations/lib/fixer.mjs" {
  export const REHEARSAL_BUDGET: { maxFixerCalls: number; maxWallClockMs: number; maxPatchesPerIndex: number; maxNormalPauses: number };
  export function detectHumanActionable(msg: string): { reasoning: string; userInstructions: string } | null;
  export function applyPatch(steps: any[], index: number, patch: any): any[];
  export function validatePatch(value: any): any;
  export function proposePatch(input: any): Promise<any>;
}
declare module "*/automations/lib/browser-client.mjs" {
  export function browserBaseUrl(): string | null;
  export function makeBrowserClient(opts?: any): {
    readonly tabId: string | null;
    navigate(url: string): Promise<string>;
    observe(opts?: { screenshot?: boolean }): Promise<any>;
    execute(action: any): Promise<any>;
    assert(assertion: any): Promise<any>;
    setViewport(vp: any): Promise<any>;
    evalJs(js: string): Promise<any>;
  };
}
declare module "*/mcp-gateway/scripts/lib/tools.mjs" {
  export function automationsAvailable(): boolean;
  export function callListAutomations(): Promise<any[]>;
  export function callRunAutomation(input: { id: string; inputs?: Record<string, unknown> }): Promise<any>;
}
declare module "*/automations/lib/planner.mjs" {
  export function planFromBrief(opts: any): Promise<any>;
  export function buildPlannerPrompt(opts: any): string;
  export function parsePlan(text: string): any;
  export const PLANNER_SKILL_ID: string;
}

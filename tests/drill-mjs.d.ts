// Ambient types for the Drill fitting's plain-JS (.mjs) lib modules so the TS
// tests can import them under tsc --noEmit without implicit-any errors.
declare module "*/drill/lib/store.mjs" {
  export function drillTargetRoot(): string;
  export function safeId(id: string): string;
  export function defaultDrillBook(): any;
  export function getDrillBook(): Promise<any>;
  export function saveDrillBook(patch: any): Promise<any>;
  export function defaultPage(pageId: string): any;
  export function listPages(): Promise<any[]>;
  export function getPage(pageId: string): Promise<any | null>;
  export function savePage(pageId: string, patch: any): Promise<any>;
  export function deletePage(pageId: string): Promise<boolean>;
  export function parseAreaRef(ref: string): { pageId: string; areaId: string } | null;
}
declare module "*/drill/lib/ulid.mjs" {
  export function ulid(now?: number): string;
}
declare module "*/drill/lib/picker.mjs" {
  export function defaultVendorPath(): string;
  export function vendorScript(distPath?: string): string;
  export function buildPickScript(x: number, y: number, distPath?: string): string;
  export function buildResolveScript(anchors: any): string;
  export function buildResolveManyScript(items: any[]): string;
  export function rectToPercent(rect: any, viewport: any): any;
  export function anchorsToLocatorHint(anchors: any): any;
}
declare module "*/drill/lib/viewports.mjs" {
  export const VIEWPORT_PRESETS: Record<string, any>;
  export function resolveViewport(id: string): any;
  export function viewportList(): any[];
}
declare module "*/drill/lib/compile.mjs" {
  export function resolvePageUrl(book: any, page: any): string;
  export function compileStep(step: any, page: any, opts?: { blind?: boolean }): any;
  export function selectSteps(page: any, opts?: any): any[];
  export function compileReachPath(state: any): any[];
  export function compileStepAutomation(book: any, page: any, step: any, opts?: { blind?: boolean }): any;
  export function hasAuth(book: any): boolean;
  export function resolveAuthUrl(book: any): string;
  export function normalizeAuthSteps(book: any): { id: string; description: string }[];
  export function authSuccess(book: any): string | null;
  export function compileAuthProbe(book: any): any | null;
  export function compileAuthLogin(book: any): any;
  export const AUTH_LOGIN_ID: string;
  export const AUTH_PROBE_ID: string;
  export const AUTH_VERIFY_STEP: string;
}
declare module "*/drill/lib/auth-state.mjs" {
  export function authFingerprint(auth: any): string;
  export function readAuthState(root: string): Promise<any | null>;
  export function writeAuthState(root: string, state: any): Promise<any>;
}
declare module "*/drill/lib/automations-client.mjs" {
  export function automationsBaseUrl(): string | null;
  export function runInline(opts: any): Promise<any>;
  export function runMatrix(opts: any): Promise<any>;
  export function getRun(runId: string, opts?: any): Promise<any | null>;
}
declare module "*/drill/lib/run-outcome.mjs" {
  export function legacyInfrastructureFailure(message: unknown): { component: string; code: string } | null;
  export function terminalFromAutomationRun(run: any, expectedStepId: string): any;
  export function terminalFromTransportError(error: unknown): any;
  export function terminalOpensCircuit(outcome: any): boolean;
}
declare module "*/drill/lib/runs-store.mjs" {
  export function drillHomeDir(): string;
  export function newDrillRun(opts?: any): any;
  export function saveDrillRun(record: any): Promise<any>;
  export function getDrillRun(id: string): Promise<any | null>;
  export function listDrillRuns(): Promise<any[]>;
  export function addFeedback(record: any, pageId: string, stepId: string, note: string, viewportId?: string | null): any;
  export function setOverride(record: any, pageId: string, stepId: string, verdict: string, note?: string, viewportId?: string | null): any;
  export function addObservation(record: any, text: string): any;
  export function addFinding(record: any, input: any): any;
  export function addInfraError(record: any, input: any): any;
  export function setFindingStatus(record: any, findingId: string, status: string): any;
  export function confirmedFindings(record: any): any[];
  export function undispatchedConfirmedFindings(record: any): any[];
  export function markFindingsDispatched(record: any, findingIds: string[], card: any): any;
  export function deleteDrillRun(id: string): Promise<boolean>;
  export function isInfraError(text: unknown): boolean;
  export function runListingRow(record: any): any;
  export function confirmedProductFindings(record: any): any[];
  export function productFindings(record: any): any[];
  export function normalizedInfraErrors(record: any): any[];
  export function publicRunRecord(record: any): any;
}
declare module "*/drill/lib/spec-emit.mjs" {
  export function emitAssertionCode(assertion: any): string;
  export function emittableSteps(page: any): any[];
  export function emitPageSpec(page: any, targetUrl: string): string;
}
declare module "*/drill/lib/graduate.mjs" {
  export function specRelPath(pageId: string): string;
  export function graduationPlanFor(step: any, outcome: any): any;
  export function graduateStep(book: any, pageId: string, stepId: string, plan: any): Promise<any>;
}
declare module "*/drill/lib/snapshots.mjs" {
  export function drillHomeDir(): string;
  export function saveSnapshot(pageId: string, parts: any): Promise<any>;
  export function listSnapshots(pageId: string): Promise<any[]>;
  export function getSnapshot(pageId: string, snapshotId: string): Promise<any | null>;
}
declare module "*/drill/lib/states.mjs" {
  export function slugifyStateId(label: string): string;
  export function assessAutomaticStateReference(outcome: any): {
    eligible: boolean;
    reason: string | null;
    warnings: Array<{ code: string; text: string }>;
  };
  export function promoteSnapshotToState(pageId: string, snapshotId: string, opts?: any): Promise<any>;
}
declare module "*/drill/lib/state-fingerprint.mjs" {
  export function routePattern(url: string): string;
  export function sameRouteAndHeading(a: any, b: any): boolean;
  export function shapeSimilarity(sketchA: string, sketchB: string): number;
  export const SHAPE_THRESHOLD: number;
  export function fingerprintPreFilterMatch(candidate: any, reference: any, threshold?: number): boolean;
}
declare module "*/drill/lib/state-matcher.mjs" {
  export function matchByAssertion(states: any[], deterministicResults: Map<string, boolean> | undefined): any;
  export function matchByFingerprint(states: any[], candidateParts: any): any;
  export function matchState(states: any[], input?: any): any;
}
declare module "*/drill/lib/heartbeat.mjs" {
  export function findPendingHeartbeatRuns(): Promise<any[]>;
  export function runHeartbeatSweep(dispatchFn: (record: any, confirmed: any[]) => Promise<any>): Promise<any[]>;
}
declare module "*/drill/test-fixtures/serve.mjs" {
  import type { Server } from "node:http";
  export function createFixtureServer(): Server;
  export function startFixtureServer(port: number): Promise<Server>;
}
declare module "*/drill/lib/browser-fitting-client.mjs" {
  export function browserBaseUrl(): string | null;
  export function openTab(url?: string, opts?: any): Promise<string>;
  export function evalJs(tabId: string, js: string, opts?: any): Promise<any>;
  export function observeTab(tabId: string, opts?: any): Promise<any>;
  export function setViewport(tabId: string, vp: any, opts?: any): Promise<any>;
  export function canvasUrl(tabId: string, viewport?: { width: number; height: number } | null): string | null;
  export function navigateTab(tabId: string, url: string, opts?: any): Promise<any>;
  export function tabAction(tabId: string, action: string, opts?: any): Promise<any>;
  export function closeTab(tabId: string, opts?: any): Promise<any>;
  export function tabInfo(tabId: string, opts?: any): Promise<any | null>;
  export function readConsole(tabId: string, opts?: any): Promise<any>;
}

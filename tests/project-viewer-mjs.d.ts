// Ambient types for the Project Viewer's plain-JS (.mjs) lib modules so the TS
// tests can import them under `tsc --noEmit` without implicit-any errors.
declare module "*/project-viewer/lib/extract.mjs" {
  export function splitLines(text: string): string[];
  export function hashText(text: string): string;
  export function sliceSpan(text: string, startLine: number, endLine: number): string;
  export function verifySpanSample(
    fileText: string | null,
    sample: any
  ): { ok: boolean; expected: string | null; actual: string | null; text: string | null; error: string | null };
  export function verifyDiffSample(sample: any): { ok: boolean; expected: string | null; actual: string | null; error: string | null };
  export function inferLang(file: string): string;
  export function normaliseHighlights(highlights: unknown, startLine: number, endLine: number): number[][];
  export function isHighlighted(line: number, highlights: unknown): boolean;
}
declare module "*/project-viewer/lib/manifest.mjs" {
  export const SCHEMA_VERSION: number;
  export const SOURCES: string[];
  export const STEP_KINDS: string[];
  export const STALENESS: string[];
  export const SEVERITIES: string[];
  export const FINDING_STATUSES: string[];
  export const DETAIL_LEVELS: string[];
  export const EVIDENCE: string[];
  export function validateFlow(obj: unknown): { ok: boolean; errors: string[] };
  export function validateFindings(obj: unknown): { ok: boolean; errors: string[] };
  export function validateViewerIndex(obj: unknown): { ok: boolean; errors: string[] };
  export function safeId(text: string, fallback?: string): string;
}
declare module "*/project-viewer/lib/highlight.mjs" {
  export function escapeHtml(text: unknown): string;
  export function tokenizeLine(line: string, lang?: string): { type: string; text: string }[];
  export function highlightLine(line: string, lang?: string): string;
  export function renderCodeBlock(
    text: string,
    opts?: { startLine?: number; lang?: string; highlights?: number[][]; file?: string }
  ): string;
}
declare module "*/project-viewer/lib/diff.mjs" {
  export function parseHunk(patch: string): any;
  export function parseFilePatch(patch: string): any[];
  export function renderHunk(patch: string, opts?: { lang?: string; file?: string }): string;
  export function renderFilePatch(patch: string, opts?: { file?: string; status?: string }): string;
  export function diffStats(patch: string): { added: number; removed: number };
  export function splitByFile(diffText: string): { file: string; status: string; patch: string }[];
}
declare module "*/project-viewer/lib/invalidate.mjs" {
  export function parseUnifiedZeroDiff(diffText: string): Map<string, any>;
  export function hunksTouch(hunks: any, startLine: number, endLine: number): boolean;
  export function deltaAbove(hunks: any, line: number): number;
  export function rebaseSpan(span: any, hunks: any): any;
  export function refreshStep(step: any, byFile: Map<string, any>, newSha: string, readAt: (f: string) => string | null): any;
  export function refreshFlow(flow: any, byFile: Map<string, any>, newSha: string, readAt: (f: string) => string | null): any;
  export function refreshFindings(findings: any[], byFile: Map<string, any>): { findings: any[]; touched: string[] };
}
declare module "*/project-viewer/lib/file-index.mjs" {
  export function buildFileIndex(flows: any[]): Record<string, { flowId: string; stepIds: string[] }[]>;
  export function addFindingSpans(index: any, findings: any[]): any;
  export function uncommittedView(statusEntries: any[], fileIndex: any): any[];
  export function flowsTouchingFiles(fileIndex: any, files: string[]): string[];
  export function stalenessSummary(flows: any[]): { fresh: number; stale: number; invalidated: number; total: number };
}
declare module "*/project-viewer/lib/render.mjs" {
  export function prose(text: unknown): string;
  export function layout(opts: any): string;
  export function stalenessBadge(staleness: any, lang?: string): string;
  export function machineIndex(flow: any, opts?: { stateIndex?: number | null }): any;
  export function renderStep(step: any, resolved: any, opts?: any): string;
  export function renderFlowState(flow: any, opts?: any): string;
  export function renderFlowOutline(flow: any, opts?: any): string;
  export function renderIndex(flows: any[], opts?: any): string;
  export function renderProjects(rows: any[], opts?: any): string;
  export function renderFlowLogic(flow: any, opts?: any): string;
  export function renderFindings(findings: any[], opts?: any): string;
  export function renderFileToFlows(fileIndex: any, opts?: any): string;
  export function renderFileDetail(file: string, entries: any[], opts?: any): string;
  export function renderUncommitted(entries: any[], opts?: any): string;
  export function renderCommitList(commits: any[], opts?: any): string;
  export function renderCommitDiff(meta: any, patches: any[], opts?: any): string;
  export function renderDocsIndex(docs: any[], opts?: any): string;
  export function renderDoc(doc: any, text: string, opts?: any): string;
  export function renderCompare(report: any, opts?: any): string;
  export function renderError(status: number, message: string, opts?: any): string;
}
declare module "*/project-viewer/lib/prompts.mjs" {
  export const MODES: string[];
  export function updatePrompt(ctx: any): string;
  export function fixPrompt(ctx: any): string;
  export function generateTestsPrompt(ctx: any): string;
  export function comparePrompt(ctx: any): string;
  export function walkthroughPrompt(ctx: any): string;
  export function fullRunPrompt(ctx: any): string;
  export function cleanupPrompt(ctx: any): string;
  export function askPrompt(ctx: any): string;
  export function buildDispatch(mode: string, ctx: any): { title: string; prompt: string; transport: string };
}
declare module "*/project-viewer/lib/i18n.mjs" {
  export const LANGS: string[];
  export const DEFAULT_LANG: string;
  export function normaliseLang(value: unknown, fallback?: string | null): string;
  export function pickText(value: unknown, lang?: string): string;
  export function t(lang: string, key: string, vars?: Record<string, unknown>): string;
  export function otherLang(lang: string): string;
  export function keysFor(lang: string): string[];
}
declare module "*/project-viewer/scripts/server.mjs" {
  export function readConfig(argv?: string[], env?: Record<string, string | undefined>): any;
  export function safeReturnPath(referer: string | undefined): string;
  export function main(argv?: string[]): Promise<any>;
}
declare module "*/project-viewer/lib/samples.mjs" {
  export function spanSample(root: string, opts: any): Promise<any>;
  export function workingTreeSample(root: string, opts: any): Promise<any>;
  export function workingTreeDiffSamples(root: string): Promise<any[]>;
  export function splitHunks(patchText: string): any[];
  export function commitDiffSamples(root: string, sha: string, relPath?: string): Promise<any[]>;
  export function verifyStepSample(root: string, step: any, opts?: any): Promise<any>;
}
declare module "*/project-viewer/lib/route-resolve.mjs" {
  export function pathSegments(urlPath: string): string[];
  export function patternFor(file: string, appDir?: string): any;
  export function matchPattern(pattern: any, segments: string[]): Record<string, unknown> | null;
  export function resolveAppRoute(urlPath: string, appFiles: string[], opts?: any): any;
  export function layoutChain(pageFile: string, appFiles: string[], appDir?: string): string[];
  export function resolveApiRoute(urlPath: string, appFiles: string[], opts?: any): any;
  export function redirectTargetOf(text: string): { target: string | null; kind: string } | null;
  export function resolveThroughRedirects(urlPath: string, appFiles: string[], opts?: any): any;
}
declare module "*/project-viewer/lib/import-graph.mjs" {
  export function importSpecifiers(text: string): string[];
  export function isLocal(spec: string, aliases: Record<string, string>): boolean;
  export function resolveSpecifier(spec: string, fromFile: string, opts: any): string | null;
  export function normalise(p: string): string;
  export function importCandidates(entry: string, opts: any): { file: string; depth: number; via: string }[];
  export function rankCandidates(candidates: any[], opts?: any): any[];
}
declare module "*/project-viewer/lib/captures.mjs" {
  export const CAPTURE_SCHEMA_VERSION: number;
  export function testKey(t: { file?: string; title?: string; project?: string | null }): string;
  export function runDir(repo: string, runId: string, env?: any): string;
  export function capturePath(repo: string, runId: string, key: string, env?: any): string;
  export function rawDir(repo: string, runId: string, env?: any): string;
  export function buildCapture(input: any): any;
  export function actionEvent(seq: number, a: any): any;
  export function routeEvent(seq: number, r: any): any;
  export function candidatesEvent(seq: number, c: any): any;
  export function writeCapture(repo: string, runId: string, key: string, capture: any, env?: any): Promise<string>;
  export function readCapture(repo: string, runId: string, key: string, env?: any): Promise<any>;
  export function listRuns(repo: string, env?: any): Promise<string[]>;
  export function listCaptures(repo: string, runId: string, env?: any): Promise<string[]>;
  export function captureRef(repo: string, runId: string, key: string): string;
  export function noCoverageFinding(flowId: string, opts?: { file?: string | null }): any;
}
declare module "*/project-viewer/lib/spine.mjs" {
  export function isNavigationAction(action: string): boolean;
  export function stepTitle(a: { action: string; arg?: string | null; url?: string | null }): string;
  export function admissionsFor(input: { action?: any; route?: any }): string[];
  export function specFromCapture(
    capture: any,
    opts?: { captureRef?: string | null; flowId?: string | null; title?: string | null }
  ): any;
  export function checkSpine(flow: any, spine: any[]): { ok: boolean; errors: string[] };
}
declare module "*/project-viewer/lib/static-scan.mjs" {
  export function isSourceFile(file: string): boolean;
  export function isTestFile(file: string): boolean;
  export function isFrameworkEntry(file: string): boolean;
  export function exportsOf(text: string, file?: string | null): { exports: any[]; opaqueReexport: boolean };
  export function countReferences(text: string, name: string): number;
  export function scanExports(
    files: string[],
    opts: { read: (f: string) => string | null; referenceFiles?: string[] | null }
  ): { files: number; scanned: number; searched: number; symbols: any[]; opaqueReexports: string[] };
  export function isTypeExport(kind: string): boolean;
  export function deadCandidates(scan: any): any[];
  export function duplicateNames(scan: any, opts?: { ignore?: string[] }): any[];
}
declare module "*/project-viewer/lib/compare.mjs" {
  export function observedFiles(captures: any[]): Set<string>;
  export function narratedFiles(flows: any[]): Set<string>;
  export function buildCompareReport(input: any): any;
  export function compareMarkdown(report: any): string;
  export function noteFor(d: any): string;
  export function coverageCaveat(captures: any[]): string[];
  export function countByArea(items: any[]): { area: string; count: number }[];
}
declare module "*/project-viewer/scripts/update.mjs" {
  export function sampleFilesOf(flow: any): string[];
  export function readerAt(repo: string, sha: string, files: string[]): Promise<(f: string) => string | null>;
  export function updateRepo(repo: string, opts?: any): Promise<any>;
}
declare module "*/project-viewer/scripts/build-flow.mjs" {
  export function buildFromSpec(repo: string, spec: any, opts?: { sha?: string }): Promise<any>;
  export function buildFromCommit(
    repo: string,
    sha: string,
    opts?: { title?: string; maxHunks?: number }
  ): Promise<any>;
  export function specsFromRun(repo: string, runId: string, opts?: { only?: string | null }): Promise<any[]>;
}
declare module "*/project-viewer/scripts/capture-runtime.mjs" {
  export function listAppFiles(repo: string, appDir?: string): Promise<string[]>;
  export function stitchUrls(actions: any[]): any[];
  export function stripOrigin(url: string): string;
  export function enrich(repo: string, raw: any, ctx: any): Promise<any>;
}declare module "*/project-viewer/runtime/pv-reporter.mjs" {
  export function actionOf(title: string): string | null;
  export function argOf(title: string): string | null;
  export function isNavigation(action: string): boolean;
  export default class ProjectViewerReporter {
    constructor(options?: { outputDir?: string });
  }
}declare module "*/project-viewer/lib/git.mjs" {
  export function toRepoPath(p: string): string;
  export function isGitRepo(root: string): Promise<boolean>;
  export function headSha(root: string): Promise<string>;
  export function resolveSha(root: string, rev: string): Promise<string>;
  export function lsFiles(root: string): Promise<string[]>;
  export function isDirty(root: string): Promise<boolean>;
  export function gitShow(root: string, sha: string, relPath: string): Promise<string | null>;
  export function readWorkingTree(root: string, relPath: string): Promise<string | null>;
  export function diffUnifiedZero(root: string, oldSha: string, newSha: string): Promise<string>;
  export function isStructuralDiffLine(line: string): boolean;
  export function diffWorkingTree(root: string): Promise<string>;
  export function commitPatch(root: string, sha: string, relPath?: string): Promise<string>;
  export function commitFiles(root: string, sha: string): Promise<any[]>;
  export function parseNameStatus(out: string): any[];
  export function commitMeta(root: string, sha: string): Promise<any>;
  export function recentCommits(root: string, limit?: number): Promise<any[]>;
  export function statusPorcelain(root: string): Promise<string>;
  export function parsePorcelainZ(out: string): any[];
  export function repoRoot(root: string): Promise<string>;
}
declare module "*/project-viewer/lib/drillbook.mjs" {
  export const BOOK_PATH: string;
  export const PAGES_DIR: string;
  export function loadYaml(text: string): Promise<any>;
  export function parseBook(obj: any): {
    app: { name: string | null; url: string | null };
    globalRules: string | null;
    viewports: string[];
    pages: { id: string; title: string; path: string; mode: string; selected: boolean }[];
  };
  export function parsePage(obj: any, opts?: { id?: string | null }): any;
  export function readDrillbook(repo: string, opts: { readFile: (f: string) => Promise<string | null> }): Promise<any>;
  export function navigationsFor(page: any): { stateId: string; label: string; url: string; intent: string }[];
}
declare module "*/project-viewer/scripts/capture-drillbook.mjs" {
  export function pathOf(url: string): string;
  export function captureForPage(page: any, ctx: any): any;
}
declare module "*/project-viewer/lib/docs-survey.mjs" {
  export function isProjectDoc(file: string): boolean;
  export function isProtectedDoc(file: string): boolean;
  export function headingsOf(text: string): { level: number; text: string; line: number }[];
  export function docSummary(text: string, max?: number): string;
  export function selfDeclaredMarkers(text: string): string[];
  export function linkedDocsOf(text: string, fromFile?: string): string[];
  export function mentionedPaths(text: string): string[];
  export function surveyDoc(input: {
    file: string;
    text: string;
    narratedFiles?: Set<string>;
    entryLinks?: Set<string>;
  }): any;
  export function groupDocs(docs: any[]): any[];
  export function buildSurvey(input: {
    docs: any[];
    sha?: string | null;
    generatedAt?: string | null;
    flowCount?: number | null;
  }): any;
}
declare module "*/project-viewer/lib/dispatch.mjs" {
  export function peerUrl(fittingId: string, env?: any): Promise<string | null>;
  export function gatewayUrl(env?: any): string | null;
  export function instanceName(env?: any): string;
  export function openCardWithOrigin(base: string, originId: string): Promise<any>;
  export function dispatchCard(
    input: { title: string; prompt: string; project: string; originId: string },
    env?: any
  ): Promise<any>;
  export function dispatchChat(input: { prompt: string }, env?: any): Promise<any>;
}
declare module "*/project-viewer/lib/projects.mjs" {
  export const REGISTRY_VERSION: number;
  export function registryPath(env?: any): string;
  export function expandHome(p: string): string;
  export function normalisePath(p: string): string;
  export function readRegistry(env?: any): Promise<{ projects: string[] }>;
  export function labelsFor(paths: string[]): string[];
  export function listProjects(input?: { configured?: string | null; env?: any }): Promise<any[]>;
  export function resolveKey(
    key: string,
    input?: { configured?: string | null; env?: any }
  ): Promise<string | null>;
  export function addProject(
    input: string,
    opts?: { isRepo?: (dir: string) => Promise<boolean> | boolean; env?: any }
  ): Promise<any>;
  export function removeProject(
    key: string,
    opts?: { configured?: string | null; env?: any }
  ): Promise<any>;
}
declare module "*/project-viewer/lib/store.mjs" {
  export const VIEWER_DIRNAME: string;
  export function viewerDir(root: string): string;
  export function flowsDir(root: string): string;
  export function flowPath(root: string, flowId: string): string;
  export function specsDir(root: string): string;
  export function specPath(root: string, flowId: string): string;
  export function findingsPath(root: string): string;
  export function indexPath(root: string): string;
  export function intakePath(root: string): string;
  export function docsManifestPath(root: string): string;
  export function cleanupAllowlistPath(root: string): string;
  export function docsCopyDir(root: string): string;
  export function storeRoot(env?: any): string;
  export function projectKey(root: string): string;
  export function capturesDir(root: string, env?: any): string;
  export function cacheDir(root: string, env?: any): string;
  export function readJson(file: string, fallback?: any): Promise<any>;
  export function listFlowIds(root: string): Promise<string[]>;
  export function getFlow(root: string, flowId: string): Promise<any>;
  export function listFlows(root: string): Promise<any[]>;
  export function getIndex(root: string): Promise<any>;
  export function getFindings(root: string): Promise<any>;
  export function getIntake(root: string): Promise<any>;
  export function getDocsManifest(root: string): Promise<{ schemaVersion: number; docs: any[] }>;
  export function saveFlow(root: string, flow: any): Promise<string>;
  export function writeReport(file: string, obj: any): Promise<string>;
  export function saveSpec(root: string, spec: any): Promise<string>;
  export function getSpec(root: string, flowId: string): Promise<any>;
  export function listSpecIds(root: string): Promise<string[]>;
  export function saveFindings(root: string, obj: any): Promise<string>;
  export function saveIndex(root: string, obj: any): Promise<string>;
  export function saveIntake(root: string, obj: any): Promise<string>;
  export function saveDocsManifest(root: string, obj: any): Promise<string>;
  export function registerFlow(root: string, flowId: string): Promise<any>;
  export function recordRefresh(root: string, sha: string): Promise<string>;
  export function setFindingStatus(root: string, findingId: string, status: string): Promise<any>;
  export function ensureViewerDir(root: string): Promise<string>;
  export function consolidateDoc(
    root: string,
    sourceRel: string,
    opts: { docId: string; title: string }
  ): Promise<{
    docId: string;
    title: string;
    source: string;
    originalPath: string;
    sourceSha256: string;
    storedAt: string;
    consolidatedAt: string;
  }>;
}
declare module "*/project-viewer/scripts/cleanup.mjs" {
  export function isHardExcluded(rel: string): boolean;
  export function runCleanup(
    root: string,
    opts?: { apply?: boolean }
  ): Promise<{
    ok: boolean;
    problems: string[];
    checked: { rel: string; abs: string; docId: string }[];
    deleted: string[];
  }>;
}

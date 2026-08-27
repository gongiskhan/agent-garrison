import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { garrisonDir } from "./claude-home";
import { renderReportHtml } from "./results-report";

// The Results store - Garrison's universal test-evidence entry point.
//
// WHY THIS LIVES IN THE GARRISON APP AND NOT IN THE DRILL FITTING.
// The brief's hard requirement is "the link must keep working after the drill
// fitting and the MCP stop". Every own-port Fitting (drill on 7096/8096) AND
// the http-gateway are spawned by runner.up() and killed by down() - a report
// hosted there is a dead link the moment the operative stops. The Next app is
// the only always-on HTTP surface on the box (systemd `garrison-prod.service`,
// Restart=always) and it is what the tailnet root resolves to, so it is also
// the only one reachable from the phone. Ingest and serving therefore live
// here; the drill fitting bundles only the stdio MCP wrapper that calls in.
//
// Layout, one directory per run under $GARRISON_HOME/results:
//   <runId>/run.json      the record (a drillbook-compatible superset)
//   <runId>/report.html   the rendered static page, re-rendered on every write
//   <runId>/media/<name>  images, videos, extracted keyframes
//
// Records reference media by RELATIVE name only; bytes leave exclusively
// through the confined /results/<id>/media/<name> route. Same discipline as
// drill's evidence serving.

export type StepStatus = "pass" | "fail" | "skipped" | "info";
export type RunOrigin = "executed" | "reported";
export type RunStatus = "running" | "passed" | "failed" | "partial" | "canceled";
export type MediaKind = "image" | "video" | "file";

export const SCHEMA = "garrison.results/v1";

export interface MediaRef {
  name: string; // relative file name under media/
  kind: MediaKind;
  caption?: string;
  bytes?: number;
  contentType?: string;
  // Present on a video whose keyframes were extracted; the frames are ordinary
  // image MediaRefs on the same step, cross-linked by name.
  keyframes?: string[];
  // Honest record of what happened when keyframe extraction was attempted.
  keyframeNote?: string;
  at: string;
}

export interface ReportStep {
  // Drillbook-compatible core: a drill page step is {id, description, enabled,
  // tags, ...}. Everything a viewer needs to treat this as a flow source.
  id: string;
  n: number;
  description: string;
  enabled: boolean;
  tags?: string[];
  // Evidence extensions.
  name: string;
  status: StepStatus;
  at: string;
  logs?: string;
  notes?: unknown;
  media: MediaRef[];
}

export interface RunRecord {
  schema: typeof SCHEMA;
  id: string;
  origin: RunOrigin;
  title: string;
  // Drillbook page-compat fields, so a reported run can be read as a flow
  // source alongside drills/pages/*.yml.
  path: string;
  mode: "steps";
  source: {
    session: string | null; // the reporting session's identifier
    tool: string | null; // "mcp" | "http" | whatever the caller declares
    cwd: string | null;
    project: string | null;
  };
  startedAt: string;
  endedAt: string | null;
  status: RunStatus;
  summary: { pass: number; fail: number; skipped: number; info: number };
  conclusion: string | null;
  steps: ReportStep[];
  media: MediaRef[]; // run-level media, not tied to a step
  meta: Record<string, unknown>;
}

export interface OpenRunInput {
  title?: string;
  origin?: string;
  session?: string;
  tool?: string;
  cwd?: string;
  project?: string;
  path?: string;
  meta?: Record<string, unknown>;
}

export interface AppendStepInput {
  name?: string;
  status?: string;
  description?: string;
  logs?: string;
  notes?: unknown;
  tags?: string[];
  id?: string;
  at?: string;
}

export function resultsDir(): string {
  return path.join(garrisonDir(), "results");
}

export function runDir(runId: string): string {
  return path.join(resultsDir(), safeRunId(runId));
}

export function mediaDir(runId: string): string {
  return path.join(runDir(runId), "media");
}

// Ids are directory names - a single sortable slug segment, nothing else.
export function safeRunId(id: string): string {
  const raw = String(id ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(raw)) throw new Error(`invalid run id: ${raw}`);
  return raw;
}

export function isSafeMediaName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,160}$/.test(String(name ?? "")) && !String(name).includes("..");
}

// Lexicographically sortable id: base36 ms timestamp + randomness. Same intent
// as drill's ULID helper (newest-last sorts by name), without pulling a dep in.
export function newRunId(now: number = Date.now()): string {
  return `${now.toString(36).padStart(9, "0")}${randomBytes(5).toString("hex")}`;
}

function normalizeOrigin(value: unknown): RunOrigin {
  // "executed" is a claim only a real drill run may make, so it must be stated
  // explicitly. Anything else - including a missing value - is "reported".
  return value === "executed" ? "executed" : "reported";
}

function normalizeStatus(value: unknown): StepStatus {
  const s = String(value ?? "").toLowerCase();
  if (s === "pass" || s === "passed" || s === "ok" || s === "success") return "pass";
  if (s === "fail" || s === "failed" || s === "error") return "fail";
  if (s === "skip" || s === "skipped") return "skipped";
  return "info";
}

export function mediaKindFor(name: string, declared?: string): MediaKind {
  if (declared === "image" || declared === "video" || declared === "file") return declared;
  const ext = path.extname(name).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".svg"].includes(ext)) return "image";
  if ([".webm", ".mp4", ".mov", ".mkv", ".m4v"].includes(ext)) return "video";
  return "file";
}

export function contentTypeFor(name: string): string {
  const ext = path.extname(name).toLowerCase();
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".webm": "video/webm",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".m4v": "video/mp4",
    ".json": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".log": "text/plain; charset=utf-8",
    ".zip": "application/zip"
  };
  // SVG is an active document type - never served as itself (see the media route).
  return map[ext] ?? "application/octet-stream";
}

// Pure: recompute the derived counters + terminal status from the steps. A run
// with a failed step is failed; all-pass (with at least one pass) is passed;
// anything else that has ended is partial (info/skipped only, or empty).
export function summarize(steps: ReportStep[]): { summary: RunRecord["summary"]; terminal: RunStatus } {
  const summary = { pass: 0, fail: 0, skipped: 0, info: 0 };
  for (const step of steps) summary[step.status] += 1;
  const terminal: RunStatus = summary.fail > 0 ? "failed" : summary.pass > 0 ? "passed" : "partial";
  return { summary, terminal };
}

export interface EvidenceCensus {
  steps: number;
  backed: number; // steps carrying at least one artifact
  artifacts: number; // media items across steps and the run
  // The case worth naming: steps claiming pass with nothing attached to look at.
  unbackedPasses: number;
}

// Pure: how much of this run is actually shown rather than asserted. A report
// whose every step says "pass" with no artifact anywhere is a claim, not
// evidence, and the page has to say so - the whole point of the origin banner
// is that a reader can tell what backs what. Logs count for nothing here on
// purpose: a session can type a log line without having run anything, whereas
// an artifact had to be produced.
export function evidenceCensus(record: Pick<RunRecord, "steps" | "media">): EvidenceCensus {
  let backed = 0;
  let artifacts = record.media.length;
  let unbackedPasses = 0;
  for (const step of record.steps) {
    artifacts += step.media.length;
    if (step.media.length > 0) backed += 1;
    else if (step.status === "pass") unbackedPasses += 1;
  }
  return { steps: record.steps.length, backed, artifacts, unbackedPasses };
}

async function atomicWrite(file: string, body: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${randomBytes(3).toString("hex")}.tmp`;
  await fs.writeFile(tmp, body);
  await fs.rename(tmp, file);
}

// Serialize writes per run id. Steps arrive as independent HTTP requests and a
// read-modify-write race would silently drop one; this app is a single Node
// process, so an in-process promise chain is the whole fix.
const writeChains = new Map<string, Promise<unknown>>();

function withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(runId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  writeChains.set(
    runId,
    next.then(
      () => undefined,
      () => undefined
    )
  );
  return next;
}

export async function readRun(runId: string): Promise<RunRecord | null> {
  try {
    const raw = await fs.readFile(path.join(runDir(runId), "run.json"), "utf8");
    return JSON.parse(raw) as RunRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

// Persist the record AND re-render the static page beside it, so the artifact
// on disk is never behind the JSON and a mid-run reader sees the latest step.
async function persist(record: RunRecord): Promise<RunRecord> {
  const dir = runDir(record.id);
  await fs.mkdir(dir, { recursive: true });
  await atomicWrite(path.join(dir, "run.json"), JSON.stringify(record, null, 2));
  await atomicWrite(path.join(dir, "report.html"), renderReportHtml(record));
  return record;
}

export async function openRun(input: OpenRunInput = {}, now: Date = new Date()): Promise<RunRecord> {
  const id = newRunId(now.getTime());
  const record: RunRecord = {
    schema: SCHEMA,
    id,
    origin: normalizeOrigin(input.origin),
    title: String(input.title ?? "Untitled run").slice(0, 300),
    path: String(input.path ?? "/").slice(0, 300),
    mode: "steps",
    source: {
      session: input.session ? String(input.session).slice(0, 200) : null,
      tool: input.tool ? String(input.tool).slice(0, 60) : null,
      cwd: input.cwd ? String(input.cwd).slice(0, 400) : null,
      project: input.project ? String(input.project).slice(0, 400) : null
    },
    startedAt: now.toISOString(),
    endedAt: null,
    status: "running",
    summary: { pass: 0, fail: 0, skipped: 0, info: 0 },
    conclusion: null,
    steps: [],
    media: [],
    meta: input.meta && typeof input.meta === "object" ? input.meta : {}
  };
  await fs.mkdir(mediaDir(id), { recursive: true });
  return persist(record);
}

export async function appendStep(runId: string, input: AppendStepInput): Promise<{ record: RunRecord; step: ReportStep }> {
  return withRunLock(runId, async () => {
    const record = await readRun(runId);
    if (!record) throw new NotFound(`no run ${runId}`);
    if (record.endedAt) throw new Conflict(`run ${runId} is finalized`);
    const n = record.steps.length + 1;
    const name = String(input.name ?? `Step ${n}`).slice(0, 300);
    const requested = input.id ? String(input.id).replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 60) : "";
    const taken = new Set(record.steps.map((s) => s.id));
    let id = requested || `s${n}`;
    while (taken.has(id)) id = `${requested || "s"}-${n}-${taken.size}`;
    const step: ReportStep = {
      id,
      n,
      // Drillbook reads `description`; the evidence surface reads `name`. A
      // caller that gives only a name still produces a valid drillbook step.
      description: String(input.description ?? name).slice(0, 4000),
      enabled: true,
      ...(Array.isArray(input.tags) && input.tags.length ? { tags: input.tags.map((t) => String(t).slice(0, 60)).slice(0, 20) } : {}),
      name,
      status: normalizeStatus(input.status),
      at: input.at ? String(input.at) : new Date().toISOString(),
      ...(input.logs ? { logs: String(input.logs).slice(0, 200_000) } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      media: []
    };
    record.steps.push(step);
    record.summary = summarize(record.steps).summary;
    await persist(record);
    return { record, step };
  });
}

// The reserved stepId meaning "this belongs to the whole run, not a step" -
// a full-run recording arrives AFTER the last step, where the default
// newest-step rule would file it under whatever ran last.
export const RUN_LEVEL = "run";

// Attach an already-written media file (the bytes land in media/ first, then
// this records the reference) to a step, to the newest step when stepId is
// absent, or to the run itself for RUN_LEVEL.
export async function attachMedia(
  runId: string,
  ref: MediaRef,
  stepId?: string | null
): Promise<{ record: RunRecord; ref: MediaRef }> {
  return withRunLock(runId, async () => {
    const record = await readRun(runId);
    if (!record) throw new NotFound(`no run ${runId}`);
    if (stepId === RUN_LEVEL) {
      record.media.push(ref);
    } else if (stepId) {
      const step = record.steps.find((s) => s.id === stepId) ?? null;
      if (!step) throw new NotFound(`no step ${stepId} on run ${runId}`);
      step.media.push(ref);
    } else if (record.steps.length) {
      // No step named: the newest step is what the caller was just doing.
      record.steps[record.steps.length - 1].media.push(ref);
    } else {
      record.media.push(ref);
    }
    await persist(record);
    return { record, ref };
  });
}

export async function finalizeRun(
  runId: string,
  input: { status?: string; conclusion?: string } = {}
): Promise<RunRecord> {
  return withRunLock(runId, async () => {
    const record = await readRun(runId);
    if (!record) throw new NotFound(`no run ${runId}`);
    const { summary, terminal } = summarize(record.steps);
    record.summary = summary;
    const declared = String(input.status ?? "").toLowerCase();
    record.status =
      declared === "passed" || declared === "failed" || declared === "partial" || declared === "canceled"
        ? (declared as RunStatus)
        : terminal;
    record.endedAt = record.endedAt ?? new Date().toISOString();
    if (input.conclusion) record.conclusion = String(input.conclusion).slice(0, 8000);
    await persist(record);
    return record;
  });
}

export interface RunListingRow {
  id: string;
  title: string;
  origin: RunOrigin;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
  steps: number;
  summary: RunRecord["summary"];
  session: string | null;
}

export function listingRow(record: RunRecord): RunListingRow {
  return {
    id: record.id,
    title: record.title,
    origin: record.origin,
    status: record.status,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    steps: record.steps.length,
    summary: record.summary,
    session: record.source.session
  };
}

export async function listRuns(limit = 200): Promise<RunListingRow[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(resultsDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  // Ids sort by creation time, so newest-first is a reverse name sort - no
  // stat() per run, which keeps a long history cheap to list.
  const ids = entries.sort().reverse().slice(0, limit);
  const rows: RunListingRow[] = [];
  for (const id of ids) {
    try {
      const record = await readRun(id);
      if (record) rows.push(listingRow(record));
    } catch {
      // A half-written or hand-edited run must not take the whole list down.
    }
  }
  return rows;
}

export async function deleteRun(runId: string): Promise<boolean> {
  const dir = runDir(runId);
  try {
    await fs.rm(dir, { recursive: true, force: false });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export class NotFound extends Error {}
export class Conflict extends Error {}

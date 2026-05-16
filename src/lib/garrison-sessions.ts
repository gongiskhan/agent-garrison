import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { computeUrls, resolveTailscaleHostname } from "./tailscale";
import type { Tier, WorktreeBinding, WorktreeStatus } from "./types";

// Writer-side store for per-worktree Claude Code session state. Garrison owns
// `~/.garrison/sessions/state.json`. During the migration window we also read
// `~/.sequoias/state.json` as fallback so Sequoias-managed sessions stay
// visible while users transition. Once Sequoias is retired, the fallback is
// dead code but harmless.

export const SESSION_STATUSES = [
  "starting",
  "working",
  "waiting",
  "idle",
  "errored",
  "dead"
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export type StartupCommandsStatus = "pending" | "running" | "success" | "failed";

export interface Session {
  branch: string;
  worktreePath: string;
  ports?: Record<string, number>;
  envFiles?: string[];
  createdAt: string;
  lastStatus: SessionStatus;
  lastStatusAt: string;
  lastHookEvent?: string;
  // Worktree-level fields (Phase 9A)
  id?: string;
  title?: string;
  baseBranch?: string;
  status?: WorktreeStatus;
  urls?: Record<string, string>;
  bindings?: WorktreeBinding[];
  // Startup command execution status (Phase 2.2)
  startupCommandsStatus?: StartupCommandsStatus;
  startupCommandsAt?: string;
  startupCommandsError?: string;
}

export interface Project {
  path: string;
  name: string;
  sessions: Record<string, Session>;
}

export interface State {
  version: 1;
  projects: Record<string, Project>;
}

export interface WorktreeSession {
  branch: string;
  worktreePath: string;
  lastStatus: SessionStatus;
  lastStatusAt: string;
  projectName: string;
  projectPath: string;
}

const TierSchema = z
  .object({
    model: z.string(),
    effort: z.string().optional(),
    needs_testing: z.boolean().optional(),
    needs_agents_team: z.boolean().optional()
  })
  .passthrough();

const BindingSchema = z
  .object({
    soul: z.string(),
    sessionId: z.string(),
    mode: z.enum(["headless", "workbench"]),
    tier: TierSchema,
    tierFlags: z.array(z.string()),
    terminalTabId: z.string().optional(),
    spawnedAt: z.string(),
    lastSummaryAt: z.string().optional()
  })
  .passthrough();

const SessionSchema = z
  .object({
    branch: z.string().optional(),
    worktreePath: z.string().optional(),
    ports: z.record(z.number()).optional(),
    envFiles: z.array(z.string()).optional(),
    createdAt: z.string().optional(),
    lastStatus: z.enum(SESSION_STATUSES).optional(),
    lastStatusAt: z.string().optional(),
    lastHookEvent: z.string().optional(),
    id: z.string().optional(),
    title: z.string().optional(),
    baseBranch: z.string().optional(),
    status: z.enum(["active", "merged", "discarded"]).optional(),
    urls: z.record(z.string()).optional(),
    bindings: z.array(BindingSchema).optional(),
    startupCommandsStatus: z.enum(["pending", "running", "success", "failed"]).optional(),
    startupCommandsAt: z.string().optional(),
    startupCommandsError: z.string().optional()
  })
  .passthrough();

const ProjectSchema = z
  .object({
    path: z.string().optional(),
    name: z.string().optional(),
    sessions: z.record(SessionSchema).optional()
  })
  .passthrough();

const StateSchema = z
  .object({
    version: z.literal(1).optional(),
    projects: z.record(ProjectSchema).optional()
  })
  .passthrough();

export function garrisonDir(): string {
  return path.join(homedir(), ".garrison");
}

export function garrisonSessionsDir(): string {
  return path.join(garrisonDir(), "sessions");
}

// GARRISON_STATE_PATH env override lets tests redirect state away from the
// real ~/.garrison/sessions/state.json without threading opts.statePath through
// every call site. Picked up by all helpers via DEFAULT_GARRISON_STATE_PATH.
export const DEFAULT_GARRISON_STATE_PATH =
  process.env.GARRISON_STATE_PATH && process.env.GARRISON_STATE_PATH.trim().length > 0
    ? process.env.GARRISON_STATE_PATH
    : path.join(garrisonSessionsDir(), "state.json");
export const DEFAULT_SEQUOIAS_STATE_PATH = path.join(
  homedir(),
  ".sequoias",
  "state.json"
);

function emptyState(): State {
  return { version: 1, projects: {} };
}

async function readStateFile(filePath: string): Promise<State | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = StateSchema.safeParse(parsed);
  if (!result.success) return null;
  // Coerce loose shape into our State shape. Apply migration defaults
  // for the worktree-level fields added in Phase 9A.
  const projects: Record<string, Project> = {};
  for (const [key, project] of Object.entries(result.data.projects ?? {})) {
    const projectSessions: Record<string, Session> = {};
    for (const [branchKey, session] of Object.entries(project.sessions ?? {})) {
      // Read-time migration synthesises only deterministic fields.
      // `id` is deliberately NOT synthesised here — UUID assignment happens
      // in upsertSession, so consecutive reads remain stable.
      const ports = session.ports;
      const branch = session.branch ?? branchKey;
      const baseBranch = session.baseBranch ?? "main";
      const status = (session.status ?? "active") as WorktreeStatus;
      const urls = session.urls ?? computeUrls(ports);
      const bindings = (session.bindings as WorktreeBinding[] | undefined) ?? [];
      projectSessions[branchKey] = {
        branch,
        worktreePath: session.worktreePath ?? "",
        ports,
        envFiles: session.envFiles,
        createdAt: session.createdAt ?? "",
        lastStatus: session.lastStatus ?? "idle",
        lastStatusAt: session.lastStatusAt ?? "",
        lastHookEvent: session.lastHookEvent,
        id: session.id,
        title: session.title,
        baseBranch,
        status,
        urls,
        bindings
      };
    }
    projects[key] = {
      path: project.path ?? key,
      name: project.name ?? path.basename(project.path ?? key),
      sessions: projectSessions
    };
  }
  return { version: 1, projects };
}

async function writeStateFile(filePath: string, state: State): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2));
  await fsp.rename(tmp, filePath);
}

export function parseStateJson(raw: string): WorktreeSession[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const result = StateSchema.safeParse(parsed);
  if (!result.success) return [];
  const out: WorktreeSession[] = [];
  for (const project of Object.values(result.data.projects ?? {})) {
    for (const [branchKey, session] of Object.entries(project.sessions ?? {})) {
      out.push({
        branch: session.branch ?? branchKey,
        worktreePath: session.worktreePath ?? "",
        lastStatus: session.lastStatus ?? "idle",
        lastStatusAt: session.lastStatusAt ?? "",
        projectName: project.name ?? path.basename(project.path ?? branchKey),
        projectPath: project.path ?? branchKey,
      });
    }
  }
  return out;
}

export interface LoadSessionsOptions {
  garrisonStatePath?: string;
  sequoiasStatePath?: string;
}

// Reader: merges Garrison-owned sessions with Sequoias's during migration. On
// branch-key collision, Garrison wins.
export async function loadAllSessions(
  opts: LoadSessionsOptions = {}
): Promise<WorktreeSession[]> {
  const garrison = await readStateFile(
    opts.garrisonStatePath ?? DEFAULT_GARRISON_STATE_PATH
  );
  const sequoias = await readStateFile(
    opts.sequoiasStatePath ?? DEFAULT_SEQUOIAS_STATE_PATH
  );
  const seen = new Set<string>();
  const out: WorktreeSession[] = [];

  function ingest(state: State | null): void {
    if (!state) return;
    for (const project of Object.values(state.projects)) {
      for (const session of Object.values(project.sessions)) {
        const key = `${project.path}::${session.branch}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          branch: session.branch || "(unknown)",
          worktreePath: session.worktreePath || "",
          lastStatus: session.lastStatus,
          lastStatusAt: session.lastStatusAt,
          projectName: project.name,
          projectPath: project.path
        });
      }
    }
  }

  ingest(garrison);
  ingest(sequoias);
  return out;
}

// Writer surface used by the hook endpoint and worktree create/remove flows.
export interface WriteOptions {
  statePath?: string;
}

async function withStateMutation(
  filePath: string,
  mutate: (state: State) => void
): Promise<State> {
  const existing = (await readStateFile(filePath)) ?? emptyState();
  mutate(existing);
  await writeStateFile(filePath, existing);
  return existing;
}

export function ensureProject(state: State, projectPath: string): Project {
  let project = state.projects[projectPath];
  if (!project) {
    project = {
      path: projectPath,
      name: path.basename(projectPath),
      sessions: {}
    };
    state.projects[projectPath] = project;
  }
  return project;
}

export async function upsertSession(
  projectPath: string,
  session: Session,
  opts: WriteOptions = {}
): Promise<void> {
  await withStateMutation(opts.statePath ?? DEFAULT_GARRISON_STATE_PATH, (state) => {
    const project = ensureProject(state, projectPath);
    const existing = project.sessions[session.branch];
    const merged: Session = {
      ...session,
      id: session.id ?? existing?.id ?? randomUUID(),
      status: session.status ?? existing?.status ?? "active",
      baseBranch: session.baseBranch ?? existing?.baseBranch ?? "main",
      urls: session.urls ?? computeUrls(session.ports),
      bindings: session.bindings ?? existing?.bindings ?? []
    };
    project.sessions[session.branch] = merged;
  });
}

export async function removeSession(
  projectPath: string,
  branch: string,
  opts: WriteOptions = {}
): Promise<void> {
  await withStateMutation(opts.statePath ?? DEFAULT_GARRISON_STATE_PATH, (state) => {
    const project = state.projects[projectPath];
    if (!project) return;
    delete project.sessions[branch];
  });
}

export async function setSessionStatus(
  projectPath: string,
  branch: string,
  status: SessionStatus,
  hookEvent?: string,
  opts: WriteOptions = {}
): Promise<boolean> {
  let matched = false;
  await withStateMutation(opts.statePath ?? DEFAULT_GARRISON_STATE_PATH, (state) => {
    const project = state.projects[projectPath];
    if (!project) return;
    const session = project.sessions[branch];
    if (!session) return;
    matched = true;
    session.lastStatus = status;
    session.lastStatusAt = new Date().toISOString();
    if (hookEvent) session.lastHookEvent = hookEvent;
  });
  return matched;
}

// Find the session whose worktreePath matches a given absolute path (used by
// the hook receiver, which gets CWD from the Claude Code shell).
export async function findSessionByCwd(
  cwd: string,
  opts: WriteOptions = {}
): Promise<{ projectPath: string; branch: string } | null> {
  const state =
    (await readStateFile(opts.statePath ?? DEFAULT_GARRISON_STATE_PATH)) ??
    emptyState();
  const target = safeRealpath(cwd);
  for (const [projectPath, project] of Object.entries(state.projects)) {
    for (const session of Object.values(project.sessions)) {
      if (!session.worktreePath) continue;
      if (safeRealpath(session.worktreePath) === target) {
        return { projectPath, branch: session.branch };
      }
    }
  }
  return null;
}

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export function statusFromHookEvent(event: string): SessionStatus | null {
  switch (event) {
    case "UserPromptSubmit":
    case "PostToolUse":
      return "working";
    case "Stop":
      return "idle";
    case "Notification":
      return "waiting";
    default:
      return null;
  }
}

// ───────────────────────────────────────────────────────────────────── Phase 9A
// Worktree-level helpers. The session record doubles as the worktree record,
// keyed by (projectPath, branch). The `id` field is the worktree UUID.

export interface FoundWorktree {
  projectPath: string;
  branch: string;
  session: Session;
}

// Returns the rich per-branch Session map for a project (preserves all fields:
// id, title, urls, bindings, etc.). Used by the worktrees API to enrich the
// git-worktree-list output.
export async function loadProjectSessionsRich(
  projectPath: string,
  opts: WriteOptions = {}
): Promise<Map<string, Session>> {
  const state = await readStateFile(opts.statePath ?? DEFAULT_GARRISON_STATE_PATH);
  const map = new Map<string, Session>();
  if (!state) return map;
  const target = safeRealpath(projectPath);
  for (const [key, project] of Object.entries(state.projects)) {
    const projectKey = safeRealpath(project.path ?? key);
    if (projectKey !== target) continue;
    for (const [branchKey, session] of Object.entries(project.sessions)) {
      map.set(session.branch ?? branchKey, session);
    }
  }
  return map;
}

export async function findWorktreeById(
  id: string,
  opts: WriteOptions = {}
): Promise<FoundWorktree | null> {
  const state =
    (await readStateFile(opts.statePath ?? DEFAULT_GARRISON_STATE_PATH)) ??
    emptyState();
  for (const [projectPath, project] of Object.entries(state.projects)) {
    for (const session of Object.values(project.sessions)) {
      if (session.id === id) {
        return { projectPath, branch: session.branch, session };
      }
    }
  }
  return null;
}

export async function setWorktreeStatus(
  projectPath: string,
  branch: string,
  status: WorktreeStatus,
  opts: WriteOptions = {}
): Promise<boolean> {
  let matched = false;
  await withStateMutation(opts.statePath ?? DEFAULT_GARRISON_STATE_PATH, (state) => {
    const project = state.projects[projectPath];
    if (!project) return;
    const session = project.sessions[branch];
    if (!session) return;
    matched = true;
    session.status = status;
  });
  return matched;
}

export async function setBinding(
  projectPath: string,
  branch: string,
  binding: WorktreeBinding,
  opts: WriteOptions = {}
): Promise<boolean> {
  let matched = false;
  await withStateMutation(opts.statePath ?? DEFAULT_GARRISON_STATE_PATH, (state) => {
    const project = state.projects[projectPath];
    if (!project) return;
    const session = project.sessions[branch];
    if (!session) return;
    matched = true;
    const existing = session.bindings ?? [];
    const idx = existing.findIndex(
      (b) => b.sessionId === binding.sessionId || b.soul === binding.soul
    );
    if (idx >= 0) existing[idx] = binding;
    else existing.push(binding);
    session.bindings = existing;
  });
  return matched;
}

export async function removeBinding(
  projectPath: string,
  branch: string,
  predicate: { sessionId?: string; soul?: string },
  opts: WriteOptions = {}
): Promise<boolean> {
  let matched = false;
  await withStateMutation(opts.statePath ?? DEFAULT_GARRISON_STATE_PATH, (state) => {
    const project = state.projects[projectPath];
    if (!project) return;
    const session = project.sessions[branch];
    if (!session) return;
    const before = session.bindings ?? [];
    const after = before.filter((b) => {
      if (predicate.sessionId && b.sessionId === predicate.sessionId) return false;
      if (predicate.soul && b.soul === predicate.soul) return false;
      return true;
    });
    if (after.length !== before.length) {
      matched = true;
      session.bindings = after;
    }
  });
  return matched;
}

export async function updateBindingLastSummary(
  projectPath: string,
  branch: string,
  sessionId: string,
  lastSummaryAt: string,
  opts: WriteOptions = {}
): Promise<boolean> {
  let matched = false;
  await withStateMutation(opts.statePath ?? DEFAULT_GARRISON_STATE_PATH, (state) => {
    const project = state.projects[projectPath];
    if (!project) return;
    const session = project.sessions[branch];
    if (!session?.bindings) return;
    const binding = session.bindings.find((b) => b.sessionId === sessionId);
    if (!binding) return;
    matched = true;
    binding.lastSummaryAt = lastSummaryAt;
  });
  return matched;
}

export function refreshUrls(session: Session): Session {
  return { ...session, urls: computeUrls(session.ports) };
}

export function _resolveHostnameForTests(): string {
  return resolveTailscaleHostname();
}

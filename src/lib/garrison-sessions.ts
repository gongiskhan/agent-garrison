import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

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

export interface Session {
  branch: string;
  worktreePath: string;
  ports?: Record<string, number>;
  envFiles?: string[];
  createdAt: string;
  lastStatus: SessionStatus;
  lastStatusAt: string;
  lastHookEvent?: string;
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

const SessionSchema = z
  .object({
    branch: z.string().optional(),
    worktreePath: z.string().optional(),
    ports: z.record(z.number()).optional(),
    envFiles: z.array(z.string()).optional(),
    createdAt: z.string().optional(),
    lastStatus: z.enum(SESSION_STATUSES).optional(),
    lastStatusAt: z.string().optional(),
    lastHookEvent: z.string().optional()
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

export const DEFAULT_GARRISON_STATE_PATH = path.join(
  garrisonSessionsDir(),
  "state.json"
);
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
  // Coerce loose Sequoias shape into our State shape.
  const projects: Record<string, Project> = {};
  for (const [key, project] of Object.entries(result.data.projects ?? {})) {
    const projectSessions: Record<string, Session> = {};
    for (const [branchKey, session] of Object.entries(project.sessions ?? {})) {
      projectSessions[branchKey] = {
        branch: session.branch ?? branchKey,
        worktreePath: session.worktreePath ?? "",
        ports: session.ports,
        envFiles: session.envFiles,
        createdAt: session.createdAt ?? "",
        lastStatus: session.lastStatus ?? "idle",
        lastStatusAt: session.lastStatusAt ?? "",
        lastHookEvent: session.lastHookEvent
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
    project.sessions[session.branch] = session;
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

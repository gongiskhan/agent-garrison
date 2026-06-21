// Hand-written declarations for claude-sessions.mjs (the repo compiles with
// allowJs: false; Garrison's vitest gate imports this reader directly).

export interface LiveSession {
  sessionId: string;
  cwd: string;
  pid: number;
  startedAt: number | null;
  /** Supplementary only — busy/idle/waiting is hook + claudeBusy() driven. */
  status: string | null;
  updatedAt: number | null;
  kind: string | null;
}

export interface HistoryEntry {
  sessionId: string;
  cwd: string | null;
  gitBranch: string | null;
  title: string | null;
  /** First-entry timestamp (ISO string from the transcript), or null. */
  startedAt: string | null;
  /** File mtime in ms — the recency key. */
  lastActivityAt: number;
}

export function isInternalCwd(cwd: string | null | undefined): boolean;

export function readLiveRegistry(opts?: {
  excludeCwd?: (cwd: string) => boolean;
  /** Maps candidate pids → their actual OS start time (epoch ms); defaults to a batched `ps`. Injectable for tests. */
  startTimeOf?: (pids: number[]) => Map<number, number>;
}): LiveSession[];

export function listHistory(opts?: { windowDays?: number; limit?: number; maxScan?: number }): HistoryEntry[];

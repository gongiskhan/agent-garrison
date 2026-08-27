// This node's own health snapshot — the answer to "what is this machine doing
// right now", assembled entirely from local sources.
//
// Two hard properties:
//
// 1. NO state-service round trip. This is the endpoint the beat gathers to
//    POST to the state service, and the endpoint the nightly convergence card
//    health-checks a node with after a restart. If it needed the authority to
//    answer, a node could never report that the authority is unreachable.
// 2. Every probe is independently fault-isolated. A snapshot with a null `git`
//    block is a useful answer; a 500 because `git` is missing is not. Each
//    probe returns null on failure and the snapshot always renders.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { readNodeIdentity } from "@/lib/node-identity";
import { garrisonDir } from "@/lib/claude-home";
import { ROOT_DIR } from "@/lib/paths";
import { resolveActiveComposition } from "@/lib/active-composition";
import { getRunnerState } from "@/lib/runner";
import { CLIENT_SCHEMA, CLIENT_VERSION } from "./schema-window";
import { readGitSnapshot, type GitSnapshot } from "./git-status";

export type { GitSnapshot };

export interface CompositionSnapshot {
  id: string;
  status: string;
  running: boolean;
  startedAt: string | null;
  external: boolean;
}

export interface ViewsSnapshot {
  total: number;
  healthy: number;
  unhealthy: string[];
}

export interface SessionsSnapshot {
  webThreads: number;
}

export interface MeshSelfSnapshot {
  node: ReturnType<typeof readNodeIdentity>;
  schemaVersion: { min: number; max: number };
  clientVersion: string;
  platform: string;
  at: string;
  uptimeMs: number;
  composition: CompositionSnapshot | null;
  sessions: SessionsSnapshot | null;
  git: GitSnapshot | null;
  views: ViewsSnapshot | null;
  // Rolled up for the mesh row's state pill so a peer does not have to know
  // how to read every block above. See src/lib/mesh/staleness.ts.
  degraded: boolean;
  activity: "idle" | "busy";
}

const GIT_TIMEOUT_MS = 4_000;
const VIEW_HEALTH_TIMEOUT_MS = 1_200;

// Both the browser poll and the 15s beat land here, so the loopback /health
// fan-out is memoised briefly. Short enough that a fitting dying is visible
// within one beat, long enough that two readers never double-probe.
const VIEWS_CACHE_MS = 5_000;
let viewsCache: { at: number; value: ViewsSnapshot | null } | null = null;

async function probeComposition(): Promise<CompositionSnapshot | null> {
  try {
    const resolved = await resolveActiveComposition();
    const state = getRunnerState(resolved.id);
    return {
      id: resolved.id,
      status: state.status,
      running: state.status === "running",
      startedAt: state.startedAt ?? null,
      external: resolved.external
    };
  } catch {
    return null;
  }
}

// The web channel writes one file per thread under
// <garrison>/web-channel/threads/<id>.json. A directory listing is the whole
// cost; opening every thread to classify it is not worth a dashboard number,
// so this counts threads and says so rather than claiming to count live ones.
async function probeSessions(): Promise<SessionsSnapshot | null> {
  try {
    const dir = path.join(garrisonDir(), "web-channel", "threads");
    const names = await readdir(dir);
    return { webThreads: names.filter((n) => n.endsWith(".json")).length };
  } catch {
    return null;
  }
}

async function probeViewHealth(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(VIEW_HEALTH_TIMEOUT_MS),
      cache: "no-store"
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function probeViews(now: number): Promise<ViewsSnapshot | null> {
  if (viewsCache && now - viewsCache.at < VIEWS_CACHE_MS) return viewsCache.value;
  let value: ViewsSnapshot | null;
  try {
    const dir = path.join(garrisonDir(), "ui-fittings");
    const names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
    const probed = await Promise.all(
      names.map(async (name) => {
        try {
          const parsed = JSON.parse(await readFile(path.join(dir, name), "utf8")) as {
            fittingId?: unknown;
            url?: unknown;
          };
          if (typeof parsed.fittingId !== "string" || typeof parsed.url !== "string") return null;
          return { fittingId: parsed.fittingId, healthy: await probeViewHealth(parsed.url) };
        } catch {
          return null;
        }
      })
    );
    const views = probed.filter((v): v is { fittingId: string; healthy: boolean } => v !== null);
    value = {
      total: views.length,
      healthy: views.filter((v) => v.healthy).length,
      unhealthy: views.filter((v) => !v.healthy).map((v) => v.fittingId).sort()
    };
  } catch {
    value = null;
  }
  viewsCache = { at: now, value };
  return value;
}

export function resetSelfSnapshotCache(): void {
  viewsCache = null;
}

export async function readSelfSnapshot(): Promise<MeshSelfSnapshot> {
  const now = Date.now();
  const [composition, sessions, git, views] = await Promise.all([
    probeComposition(),
    probeSessions(),
    readGitSnapshot(ROOT_DIR, GIT_TIMEOUT_MS),
    probeViews(now)
  ]);

  // Degraded is deliberately narrow: a node with a running composition whose
  // own-port views are not all answering is lying if it reports READY, and
  // that is the case the nightly card's health poll exists to catch. A node
  // with nothing up is idle, not degraded.
  const degraded =
    composition?.status === "failed" ||
    Boolean(composition?.running && views !== null && views.total > 0 && views.healthy < views.total);

  // Busy means "mid-transition, do not act on this node" — the state the
  // nightly convergence card must not merge into. A composition that is simply
  // UP and waiting is ready, not busy; claiming otherwise would make every
  // healthy node in the mesh permanently unavailable.
  const activity =
    composition?.status === "starting" ||
    composition?.status === "verifying" ||
    composition?.status === "stopping"
      ? "busy"
      : "idle";

  return {
    node: readNodeIdentity(),
    schemaVersion: { min: CLIENT_SCHEMA.min, max: CLIENT_SCHEMA.max },
    clientVersion: CLIENT_VERSION,
    platform: process.platform,
    at: new Date(now).toISOString(),
    uptimeMs: Math.round(process.uptime() * 1000),
    composition,
    sessions,
    git,
    views,
    degraded,
    activity
  };
}

import { NextResponse } from "next/server";
import fsp from "node:fs/promises";
import path from "node:path";
import { loadAllSessions, parseStateJson, garrisonSessionsDir } from "@/lib/garrison-sessions";
import { listOutposts, outpostRpc } from "@/lib/outpost-rpc";

export const runtime = "nodejs";

export interface AggregatedSession {
  branch: string;
  worktreePath: string;
  lastStatus: string;
  lastStatusAt: string;
  projectName: string;
  projectPath: string;
  machine: string;
  online: boolean;
}

interface OutpostSummary {
  name: string;
  online: boolean;
  lastSyncedAt: string | null;
}

const CACHE_PATH = path.join(garrisonSessionsDir(), "outpost-cache.json");

async function readCache(): Promise<Record<string, AggregatedSession[]>> {
  try {
    const raw = await fsp.readFile(CACHE_PATH, "utf8");
    return JSON.parse(raw) as Record<string, AggregatedSession[]>;
  } catch {
    return {};
  }
}

async function writeCache(cache: Record<string, AggregatedSession[]>): Promise<void> {
  await fsp.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  const tmp = CACHE_PATH + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(cache, null, 2));
  await fsp.rename(tmp, CACHE_PATH);
}

export async function GET() {
  try {
    const localSessions = await loadAllSessions();
    const sessions: AggregatedSession[] = localSessions.map((s) => ({
      ...s,
      machine: "local",
      online: true,
    }));

    const outpostSummaries: OutpostSummary[] = [];
    const cache = await readCache();

    let outposts: Awaited<ReturnType<typeof listOutposts>>;
    try {
      outposts = await listOutposts();
    } catch {
      outposts = [];
    }

    const updatedCache: Record<string, AggregatedSession[]> = { ...cache };

    await Promise.all(
      outposts.map(async (outpost) => {
        if (!outpost.connected) {
          const cached = cache[outpost.name] ?? [];
          sessions.push(...cached.map((s) => ({ ...s, online: false })));
          outpostSummaries.push({ name: outpost.name, online: false, lastSyncedAt: null });
          return;
        }

        try {
          const result = await outpostRpc<{ content?: string; error?: string }>(
            outpost.name,
            "fs.read",
            { path: "~/.garrison/sessions/state.json" }
          );

          let outpostSessions: AggregatedSession[] = [];
          if (result?.content) {
            outpostSessions = parseStateJson(result.content).map((s) => ({
              ...s,
              machine: outpost.name,
              online: true,
            }));
          }

          sessions.push(...outpostSessions);
          updatedCache[outpost.name] = outpostSessions;
          outpostSummaries.push({
            name: outpost.name,
            online: true,
            lastSyncedAt: new Date().toISOString(),
          });
        } catch (err) {
          const errMessage = err instanceof Error ? err.message : String(err);
          const isNotFound =
            errMessage.includes("not_found") || errMessage.includes("ENOENT");

          if (isNotFound) {
            updatedCache[outpost.name] = [];
            sessions.push();
            outpostSummaries.push({
              name: outpost.name,
              online: true,
              lastSyncedAt: new Date().toISOString(),
            });
          } else {
            const cached = cache[outpost.name] ?? [];
            sessions.push(...cached.map((s) => ({ ...s, online: false })));
            outpostSummaries.push({ name: outpost.name, online: false, lastSyncedAt: null });
          }
        }
      })
    );

    try {
      await writeCache(updatedCache);
    } catch {
      // non-fatal; cache is best-effort
    }

    return NextResponse.json({ sessions, outposts: outpostSummaries });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

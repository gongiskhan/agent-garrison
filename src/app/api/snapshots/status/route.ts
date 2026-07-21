import { NextResponse } from "next/server";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { jsonError } from "@/lib/http";
import {
  formatRestoreCommand,
  readSnapshotsState,
  resolveScriptsDir
} from "../core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Snapshot {
  id: string;
  time?: string;
  paths?: string[];
  hostname?: string;
}

interface StatusEnvelope {
  repository?: string;
  error?: string;
  snapshots?: Array<{ id?: string; short_id?: string; time?: string; paths?: string[]; hostname?: string }>;
}

// GET /api/snapshots/status
// Reads the last-run record and shells status.sh for the live repository +
// snapshot list. Degrades cleanly: when credentials are absent the script still
// returns an envelope with an error and an empty list.
export async function GET() {
  try {
    const state = readSnapshotsState();
    const scriptsDir = resolveScriptsDir();

    let repository: string | null = null;
    let snapshots: Snapshot[] | null = null;
    let snapshotsError: string | undefined;

    const res = spawnSync("bash", [path.join(scriptsDir, "status.sh")], {
      env: process.env,
      encoding: "utf8",
      timeout: 15000
    });

    if (res.error) {
      snapshotsError = res.error.message;
    } else if (typeof res.stdout === "string" && res.stdout.trim().length > 0) {
      try {
        const env = JSON.parse(res.stdout.trim()) as StatusEnvelope;
        repository = env.repository && env.repository.length > 0 ? env.repository : null;
        if (env.error && env.error.length > 0) snapshotsError = env.error;
        if (Array.isArray(env.snapshots)) {
          snapshots = env.snapshots.map((s) => ({
            id: s.short_id ?? s.id ?? "",
            time: s.time,
            paths: s.paths,
            hostname: s.hostname
          }));
        }
      } catch {
        snapshotsError = "could not parse status output";
      }
    } else {
      snapshotsError = (res.stderr || "status unavailable").trim();
    }

    const latestId =
      snapshots && snapshots.length > 0 ? snapshots[snapshots.length - 1].id : "";
    const restoreHint = formatRestoreCommand(
      repository ?? "",
      latestId,
      "/path/to/restore"
    );

    return NextResponse.json({
      state,
      repository,
      snapshots,
      snapshotsError,
      restoreHint
    });
  } catch (error) {
    return jsonError(error, 500);
  }
}

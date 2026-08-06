import { NextResponse } from "next/server";
import { listDispatchMachines } from "@/lib/dispatch-machines";
import { listWorkerViews } from "@/lib/dispatch-workers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Server-to-server/read-only status vocabulary used by both own-port UIs.
// Tokens are intentionally absent.
export async function GET() {
  const [machines, workers] = await Promise.all([listDispatchMachines(), listWorkerViews()]);
  const byMachine = new Map(workers.map((worker) => [worker.machine, worker]));
  return NextResponse.json({
    protocol: "outpost-dispatch/1.1",
    machines: machines.map((machine) => ({
      ...machine,
      worker: byMachine.get(machine.name) ?? {
        state: "offline",
        stale: true,
        lastSeenAt: null,
        workerVersion: null,
        protocolVersion: null,
        runtimes: [],
        currentCardId: null,
        detail: "Task runner has not checked in",
        error: null,
        ready: false
      }
    }))
  });
}


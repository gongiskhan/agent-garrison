import type { NextRequest } from "next/server";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { getCompositionDirectory } from "@/lib/compositions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ExecutionRecord {
  id: string;
  kind: "plan" | "execute";
  project: string;
  project_path?: string;
  goal?: string;
  plan_id?: string;
  started_at: string;
  ended_at: string | null;
  status: "running" | "done" | "failed" | "killed";
  pid?: number;
  log_path: string;
  error?: string;
}

interface RegistryShape {
  executions: Record<string, ExecutionRecord>;
}

const STATE_POLL_MS = 2000;
const LOG_POLL_MS = 750;
const KEEPALIVE_MS = 15000;

async function readRegistry(compositionDir: string): Promise<RegistryShape> {
  const file = path.join(compositionDir, "data", "coding-subagent-executions.json");
  if (!existsSync(file)) return { executions: {} };
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as RegistryShape;
  } catch {
    return { executions: {} };
  }
}

function pickExecution(reg: RegistryShape, requested?: string): ExecutionRecord | null {
  const list = Object.values(reg.executions);
  if (list.length === 0) return null;
  if (requested) {
    return reg.executions[requested] ?? null;
  }
  // Prefer running, then most recent by started_at.
  const running = list.find((r) => r.status === "running");
  if (running) return running;
  return list
    .slice()
    .sort((a, b) => (a.started_at < b.started_at ? 1 : -1))[0];
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const compositionDir = getCompositionDirectory(params.id);
  const url = new URL(request.url);
  const requestedExecution = url.searchParams.get("execution_id") ?? undefined;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      let keepAliveTimer: NodeJS.Timeout | undefined;
      let logPoller: NodeJS.Timeout | undefined;
      let statePoller: NodeJS.Timeout | undefined;

      const send = (event: string, payload: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
          );
        } catch {
          /* controller closed */
        }
      };

      const close = () => {
        if (closed) return;
        closed = true;
        if (keepAliveTimer) clearInterval(keepAliveTimer);
        if (logPoller) clearInterval(logPoller);
        if (statePoller) clearInterval(statePoller);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // 1. Initial registry read.
      let registry = await readRegistry(compositionDir);
      let execution = pickExecution(registry, requestedExecution);

      send("init", {
        composition_id: params.id,
        execution,
        executions: Object.values(registry.executions)
          .sort((a, b) => (a.started_at < b.started_at ? 1 : -1))
          .slice(0, 20)
      });

      // 2. Tail the log file. We only stream the LATEST execution; if the
      //    user wants history, T7 verification covers that via list view,
      //    not real-time tail.
      let logOffset = 0;
      let trackedLogPath: string | null = execution?.log_path ?? null;

      const flushLog = async () => {
        if (!trackedLogPath || !existsSync(trackedLogPath)) return;
        try {
          const handle = await fs.open(trackedLogPath, "r");
          try {
            const stat = await handle.stat();
            if (stat.size <= logOffset) return;
            const buffer = Buffer.alloc(stat.size - logOffset);
            await handle.read(buffer, 0, buffer.length, logOffset);
            logOffset = stat.size;
            const text = buffer.toString("utf8");
            for (const line of text.split("\n")) {
              if (!line.trim()) continue;
              try {
                send("log", JSON.parse(line));
              } catch {
                send("log", { raw: line });
              }
            }
          } finally {
            await handle.close();
          }
        } catch {
          /* transient FS error; try again next tick */
        }
      };

      // 3. State poller — detects status changes (kill, completion).
      const pollState = async () => {
        registry = await readRegistry(compositionDir);
        const next = pickExecution(registry, requestedExecution);
        if (!next) return;

        if (!execution || next.id !== execution.id) {
          execution = next;
          trackedLogPath = next.log_path;
          logOffset = 0;
          send("execution-changed", { execution: next });
          return;
        }

        if (next.status !== execution.status) {
          execution = next;
          send("execution-status", {
            id: next.id,
            status: next.status,
            ended_at: next.ended_at,
            error: next.error
          });
        }
      };

      // 4. Initial flush + start pollers.
      await flushLog();
      logPoller = setInterval(() => void flushLog(), LOG_POLL_MS);
      statePoller = setInterval(() => void pollState(), STATE_POLL_MS);
      keepAliveTimer = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {
          /* closed */
        }
      }, KEEPALIVE_MS);

      // 5. Cleanup on client disconnect.
      request.signal.addEventListener("abort", close);
    },
    cancel() {
      // Setting a flag isn't enough — start() owns timers via closure.
      // The abort listener handles cleanup; this is a fallback for
      // ReadableStream semantics.
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    }
  });
}

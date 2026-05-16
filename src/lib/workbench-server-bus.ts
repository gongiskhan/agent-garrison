import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

// Phase 9E — server-side bus for http-gateway → Workbench UI events.
// http-gateway (a subprocess) can't reach the client-side workbench-bus.ts
// directly, so it POSTs to /api/workbench/spawn-soul-tab; that route writes
// here; the SSE at /api/workbench/launch-stream relays to the browser.

export interface SoulTabLaunchPayload {
  kind: "soul-tab-launch";
  terminalTabId: string;
  sessionId: string;
  soul: string;
  cwd: string;
  worktreeId?: string;
  args: string[]; // claude CLI argv (already includes --resume / --session-id, model, etc.)
  message?: string; // initial prompt to type via PTY
  mcpConfigPath?: string;
}

export interface SoulTabRespawnPayload {
  kind: "soul-tab-respawn";
  terminalTabId: string;
  sessionId: string;
  args: string[];
  message?: string;
}

export type WorkbenchServerEvent = SoulTabLaunchPayload | SoulTabRespawnPayload;

class WorkbenchServerBus {
  private emitter = new EventEmitter();
  // Pending events for subscribers that connect just after a publish. We hold
  // a small list (last 50) keyed by terminalTabId so a connecting subscriber
  // sees recent events on subscribe.
  private recent: WorkbenchServerEvent[] = [];

  emit(payload: WorkbenchServerEvent): void {
    this.recent.push(payload);
    if (this.recent.length > 50) this.recent.shift();
    this.emitter.emit("event", payload);
  }

  emitLaunch(p: Omit<SoulTabLaunchPayload, "kind" | "terminalTabId"> & { terminalTabId?: string }): string {
    const terminalTabId = p.terminalTabId ?? randomUUID();
    this.emit({ ...p, terminalTabId, kind: "soul-tab-launch" });
    return terminalTabId;
  }

  emitRespawn(p: Omit<SoulTabRespawnPayload, "kind">): void {
    this.emit({ ...p, kind: "soul-tab-respawn" });
  }

  subscribe(handler: (event: WorkbenchServerEvent) => void): () => void {
    // Replay recent on subscribe so reconnecting browsers see the last events.
    for (const ev of this.recent) {
      try { handler(ev); } catch { /* ignore replay errors */ }
    }
    this.emitter.on("event", handler);
    return () => this.emitter.off("event", handler);
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __garrisonWorkbenchServerBus: WorkbenchServerBus | undefined;
}

export function workbenchServerBus(): WorkbenchServerBus {
  globalThis.__garrisonWorkbenchServerBus ??= new WorkbenchServerBus();
  return globalThis.__garrisonWorkbenchServerBus;
}

// Dev Env placement now uses the same authored-and-generated Orchestrator
// document as every other session. The former mode picker composed a separate
// persona-mode prompt and selected a model from a persona bias; that path is
// retired. Model/duty routing happens per request in the gateway.
import { promises as fs } from "node:fs";
import path from "node:path";
import { writeAssembledOrchestratorPrompt } from "./orchestrator-projection";

export function safeComposition(id: unknown): string {
  return typeof id === "string" && /^[a-z0-9_-]+$/i.test(id) ? id : "default";
}

export interface PlacementResult {
  identity: "operative";
  promptPath: string;
  model: null;
  effort: null;
  role: null;
  targetId: null;
  runtime: null;
  provider: null;
}

export interface PlacementOptions {
  composition: string;
  channel?: string;
  decisionsPath?: string;
}

export async function placeOrchestratedSession(opts: PlacementOptions): Promise<PlacementResult> {
  const composition = safeComposition(opts.composition);
  const assembled = await writeAssembledOrchestratorPrompt(composition);
  if (opts.decisionsPath) {
    try {
      await fs.mkdir(path.dirname(opts.decisionsPath), { recursive: true });
      await fs.appendFile(
        opts.decisionsPath,
        `${JSON.stringify({
          at: new Date().toISOString(),
          kind: "session-placement",
          via: "orchestrator-authored-prompt",
          channel: opts.channel ?? "dev-env",
          composition
        })}\n`,
        "utf8"
      );
    } catch (error) {
      console.warn(`[placement] telemetry append failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    identity: "operative",
    promptPath: assembled.path,
    model: null,
    effort: null,
    role: null,
    targetId: null,
    runtime: null,
    provider: null
  };
}

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Minimal runner-projected v2 execution model for real gateway process tests.
 * It exercises the production Orchestrator dispatch-fast path without falling
 * back to the retired task-type/tier classifier.
 */
export function gatewayV4ExecutionModel(compositionId: string) {
  const duties = {
    dispatch: {
      id: "dispatch",
      title: "Dispatch",
      description: "Route one inbound request to a duty and level.",
      levels: [{ description: "bounded routing inference", cell: { target: "dispatch-fast", effort: "low" } }]
    },
    code: {
      id: "code",
      title: "Code",
      description: "Implement or repair code.",
      levels: [{ description: "bounded code change", cell: { target: "cc-sonnet-med", effort: "medium" } }]
    },
    other: {
      id: "other",
      title: "Other",
      description: "Answer a small request that needs no specialist duty.",
      levels: [{ description: "small direct request", cell: { target: "cc-haiku-low", effort: "low" } }]
    }
  };
  return {
    version: 2,
    compositionId,
    kanbanLists: ["code", "other"],
    selectedDuties: ["code", "other", "dispatch"],
    duties,
    sequences: {
      dispatch: { "1": ["dispatch"] },
      code: { "1": ["code"] },
      other: { "1": ["other"] }
    },
    steps: {
      dispatch: {
        "1": [{
          duty: "dispatch",
          targetId: "dispatch-fast",
          runtime: "agent-sdk",
          provider: "anthropic",
          model: "claude-haiku-4-5",
          effort: "low",
          params: {
            authMode: "subscription",
            promptMode: "lean",
            maxTurns: 1,
            timeoutMs: 8000,
            allowedTools: [],
            thinking: { type: "disabled" }
          }
        }]
      },
      code: {
        "1": [{
          duty: "code",
          targetId: "cc-sonnet-med",
          runtime: "claude-code",
          provider: "anthropic-plan",
          model: "sonnet",
          effort: "medium",
          params: {}
        }]
      },
      other: {
        "1": [{
          duty: "other",
          targetId: "cc-haiku-low",
          runtime: "claude-code",
          provider: "anthropic-plan",
          model: "haiku",
          effort: "low",
          params: {}
        }]
      }
    },
    holds: {},
    gates: {}
  };
}

export function writeGatewayV4ExecutionModel(compositionDir: string, kanbanRoot: string): string {
  mkdirSync(kanbanRoot, { recursive: true });
  const compositionId = path.basename(compositionDir);
  const file = path.join(kanbanRoot, "model.json");
  writeFileSync(file, `${JSON.stringify(gatewayV4ExecutionModel(compositionId), null, 2)}\n`, "utf8");
  return file;
}

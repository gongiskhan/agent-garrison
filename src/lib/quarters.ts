import { computeStateModel, type StateModel } from "./primitive-state";
import { promote, park, unpark, type TransitionResult } from "./state-transitions";

// Backend for the Quarters surface: a read (the loose/owned StateModel over the
// real ~/.claude) and the promote/park/unpark transition dispatch. Thin wrapper
// so the API route stays declarative and the dispatch is unit-testable.

export type QuartersActionRequest =
  | { action: "promote"; id: string }
  | { action: "park"; fittingId: string }
  | { action: "unpark"; slug: string; target: "owned" | "loose" };

export async function getQuartersState(): Promise<StateModel> {
  return computeStateModel();
}

export async function runQuartersAction(req: QuartersActionRequest): Promise<TransitionResult> {
  switch (req?.action) {
    case "promote":
      if (!req.id) throw new Error("promote requires { id }");
      return promote(req.id);
    case "park":
      if (!req.fittingId) throw new Error("park requires { fittingId }");
      return park(req.fittingId);
    case "unpark":
      if (!req.slug) throw new Error("unpark requires { slug }");
      return unpark(req.slug, req.target === "loose" ? "loose" : "owned");
    default:
      throw new Error(`unknown quarters action: ${(req as { action?: string })?.action}`);
  }
}

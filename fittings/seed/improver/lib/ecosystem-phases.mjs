// ecosystem-phases.mjs - shared orchestration for the two deterministic,
// non-LLM phases (ecosystem-update + reapply-sweep) that both improver.mjs's
// CLI main() and server.mjs's doRunNow() run identically. Factored out so the
// two call sites can't drift (previously copy-pasted independently).

import { runEcosystemUpdate } from "./ecosystem-update.mjs";
import { runReapplySweep } from "./reapply-sweep.mjs";

// Never throws - each phase is independently try/caught so a failure in one
// never blocks the other or whatever the caller runs next.
export async function runEcosystemPhases({ compositionDir, stateDir, queuePath, reconcileFn }) {
  try {
    await runEcosystemUpdate({ compositionDir, stateDir });
  } catch (err) {
    console.error(`improver: ecosystem-update phase failed: ${err?.stack || err?.message || err}`);
  }
  try {
    await runReapplySweep({ stateDir, queuePath, reconcileFn });
  } catch (err) {
    console.error(`improver: reapply-sweep phase failed: ${err?.stack || err?.message || err}`);
  }
}

// Tier-compare decision for the http-gateway's talk_to flow.
//
// When a new message arrives for an existing soul session, the gateway must
// decide whether to:
//   - reuse the existing process (tiers match → just pipe the new message in)
//   - kill + respawn with --resume and new model flags (tier model differs)
//
// We compare on `tier.model` only. Effort and other tier fields are conveyed
// via tierFlags which can be applied without restarting the process. Brief's
// "compare on {model, effort, needs_testing}" was narrowed to model after
// confirming that effort changes don't require a respawn.

export function shouldRespawnForTier(existingTier, newTier) {
  if (!existingTier || !newTier) return false;
  if (typeof existingTier.model !== "string" || typeof newTier.model !== "string") {
    return false;
  }
  return existingTier.model !== newTier.model;
}

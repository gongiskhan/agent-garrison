// Project inference (FINDING 3, wired + VISIBLE). A card created without a project is
// the exact case the user hit: "it didn't infer it, I didn't see a try to infer
// anywhere." This guesses the project/repository a no-project card belongs to from its
// title + description via a SHORT gateway turn — and the caller writes "inferring…" /
// result events so the ATTEMPT is always visible, even when it ends up leaving the
// project blank. The PARSE is pure + unit-testable; the gateway call is injected.

// The tiny inference prompt. Deliberately constrained — one short slug or NONE, no
// prose — so the parse is robust and the turn is fast (it must not tie up the
// operative the way a real autothing-* turn does).
export function buildInferencePrompt(card, knownProjects = []) {
  const known = knownProjects.length
    ? `\nProjects already in use (prefer one of these if it fits): ${knownProjects.join(", ")}.`
    : "";
  return [
    `A work item was filed without a project. Identify the single project or repository it most likely belongs to.`,
    ``,
    `Title: ${card?.title || "(untitled)"}`,
    card?.description ? `Description: ${card.description}` : "",
    known,
    ``,
    `Reply with ONLY the project slug — lowercase, kebab-case, no spaces — on a single line, or exactly NONE if you cannot tell with confidence. No explanation, no other text.`
  ]
    .filter((l) => l !== "")
    .join("\n");
}

// A clean project slug, and the tokens that mean "no confident answer".
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const NEGATIVE = new Set(["none", "n/a", "na", "unknown", "unsure", "unclear", "null", "-", "?"]);

// Parse the inference reply → a project slug or null. Take the last non-empty,
// non-bracket line (same discipline as the router's parseNextList — tolerate trailing
// gateway status badges), strip wrapping quotes/punctuation, and accept it only if it
// is a clean slug and not a NONE/uncertainty token.
export function parseInferredProject(reply) {
  // Strip gateway status badges ("[route: …]", "[orchestrator-active]") — including ones
  // FLOWED onto the slug's line ("ekoa [route: …]") — before reading the slug, so a
  // badge's inner punctuation can't corrupt the parse (same robustness as the verdict
  // parsers).
  const lines = String(reply ?? "")
    .replace(/\[[^\]\n]*\]/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  let token = lines[lines.length - 1].toLowerCase();
  // Strip surrounding quotes/backticks and trailing punctuation a model might add
  // ("project: `ekoa`." → "ekoa").
  token = token.replace(/^.*?[:=]\s*/, "").replace(/^[`'"\s]+|[`'".,;\s]+$/g, "").trim();
  if (!token || NEGATIVE.has(token)) return null;
  return SLUG.test(token) ? token : null;
}

// Run an inference via an injected runFn ({prompt}) → { reply }. Returns
// { project, reply } where project is the slug or null. Free of any gateway specifics
// so a test can drive it with a stub runFn.
export async function inferProject(card, runFn, { knownProjects = [] } = {}) {
  const prompt = buildInferencePrompt(card, knownProjects);
  const out = await runFn({ prompt });
  const reply = out?.reply ?? out?.text ?? String(out ?? "");
  return { project: parseInferredProject(reply), reply };
}

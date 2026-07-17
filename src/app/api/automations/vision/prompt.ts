// Pure prompt-building for the vision route — kept out of route.ts because
// Next.js's route-file export contract only allows HTTP method handlers +a
// small config export set (an extra named export fails `next typegen`).
// mode: "action" | "verify" | "judge" (Drill's drillJudge() helper, Q3 — a
// genuinely qualitative question with no deterministic assertion).
export function buildVisionPrompt(mode: string, observation: any, step: any): string {
  const a11y = Array.isArray(observation?.a11y)
    ? observation.a11y.slice(0, 80).map((n: any) => `${n.role}: ${n.name ?? ""}`).join("\n")
    : "";
  if (mode === "verify") {
    return [
      "You are resolving a browser VERIFY step. Given the page state, decide if the expected outcome holds.",
      `Expected: ${step?.expectedOutcome ?? step?.description ?? ""}`,
      `URL: ${observation?.url}\nTitle: ${observation?.title}\nHeading: ${observation?.headingText}`,
      `Accessible elements:\n${a11y}`,
      step?.areaHint ? `Known anchor for the element this step concerns: ${JSON.stringify(step.areaHint)}` : "",
      // Delta 5 (B12): prefer the most precise deterministic kind you can ground —
      // more checks graduate out of vision the more specific the emitted kind is.
      [
        "Prefer the most precise deterministic assertion kind you can ground from the above (fall back to text-contains only when nothing more specific grounds cleanly):",
        '  text-contains: { "kind":"text-contains", "text":"..." } — a substring must appear in the page\'s visible text',
        '  visible: { "kind":"visible", "testId"|"selector"|"role":"...", ... } — a specific element must be visible',
        '  count: { "kind":"count", "testId"|"selector"|"role":"...", "op":"eq|gte|lte|gt|lt", "value": N } — element count matches',
        '  url-matches: { "kind":"url-matches", "pattern":"...", "mode":"contains|regex" } — the current URL matches',
        '  attribute-equals: { "kind":"attribute-equals", "testId"|"selector"|"role":"...", "attribute":"...", "value":"..." } — an element\'s attribute equals a value'
      ].join("\n"),
      'Reply ONLY JSON: { "passed": true|false, "reasoning": "...", "assertion": { "kind": "...", ... } }'
    ].filter(Boolean).join("\n\n");
  }
  if (mode === "judge") {
    return [
      "You are answering a QUALITATIVE judgment question about the current page — this is NOT a deterministic check; use your understanding of the content, not just element presence.",
      `Question: ${step?.description ?? ""}`,
      `URL: ${observation?.url}\nTitle: ${observation?.title}`,
      observation?.bodyText ? `Page text:\n${String(observation.bodyText).slice(0, 4000)}` : `Accessible elements:\n${a11y}`,
      'Reply ONLY JSON: { "passed": true|false, "reasoning": "..." }'
    ].filter(Boolean).join("\n\n");
  }
  return [
    "You are resolving a browser ACTION step into a single Playwright action. Use the accessible elements to ground it.",
    `Goal: ${step?.description ?? ""}`,
    `URL: ${observation?.url}\nTitle: ${observation?.title}\nHeading: ${observation?.headingText}`,
    `Accessible elements (role: name):\n${a11y}`,
    'Reply ONLY JSON: { "kind":"click|fill|select|check|hover|press", "role":"button|link|textbox|...", "name":"the accessible name", "value":"(for fill/select/press)" }'
  ].join("\n\n");
}

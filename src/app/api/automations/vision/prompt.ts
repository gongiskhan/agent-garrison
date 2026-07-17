// Pure prompt-building for the vision route - kept out of route.ts because
// Next.js's route-file export contract only allows HTTP method handlers +a
// small config export set (an extra named export fails `next typegen`).
// mode: "action" | "verify" | "judge" (Drill's drillJudge() helper, Q3 - a
// genuinely qualitative question with no deterministic assertion) | "fix"
// (the self-healing fixer's patch proposal - MUST answer in the patch
// grammar, never the action grammar; a missing branch here once dropped fix
// calls into the action prompt and every patch came back as "hover"/"click").

// Every embedded field is BOUNDED. A single a11y node's accessible name can
// carry an entire data table's text (a table region node on a dense dashboard
// page measured in megabytes), and the gateway hard-fails on oversized
// messages: ~2-4MB turns come back with an EMPTY reply and ~8MB+ resets the
// socket outright - observed live 2026-07-17 as every vision call for such a
// page failing "vision 503" while small pages passed. Clipping here keeps the
// call inside the envelope the gateway actually serves.
const NAME_CAP = 240;
const JSON_CAP = 2000;
const PROMPT_CAP = 200_000;

function clip(value: unknown, cap: number): string {
  const s = String(value ?? "");
  return s.length > cap ? `${s.slice(0, cap)} [...clipped ${s.length - cap} chars]` : s;
}

export function buildVisionPrompt(mode: string, observation: any, step: any, shotPath?: string | null): string {
  const a11y = Array.isArray(observation?.a11y)
    ? observation.a11y.slice(0, 80).map((n: any) => `${n.role}: ${clip(n.name, NAME_CAP)}`).join("\n")
    : "";
  const header = `URL: ${clip(observation?.url, 500)}\nTitle: ${clip(observation?.title, 300)}\nHeading: ${clip(observation?.headingText, 300)}`;
  // The routed session has a Read tool; the screenshot line makes it LOOK at
  // the page instead of judging visual claims from the element list alone.
  const shot = shotPath
    ? `A full screenshot of the page is saved at ${shotPath} - Read that image file first and ground your judgment in what the page actually looks like.`
    : "";
  const bounded = (parts: Array<string | false | null | undefined>): string => {
    const prompt = parts.filter(Boolean).join("\n\n");
    return prompt.length > PROMPT_CAP
      ? `${prompt.slice(0, PROMPT_CAP)}\n\n[...prompt clipped at ${PROMPT_CAP} chars - judge from what is above]`
      : prompt;
  };
  if (mode === "verify") {
    return bounded([
      "You are resolving a browser VERIFY step. Given the page state, decide if the expected outcome holds.",
      `Expected: ${step?.expectedOutcome ?? step?.description ?? ""}`,
      shot,
      header,
      `Accessible elements:\n${a11y}`,
      step?.areaHint ? `Known anchor for the element this step concerns: ${clip(JSON.stringify(step.areaHint), JSON_CAP)}` : "",
      // Delta 5 (B12): prefer the most precise deterministic kind you can ground -
      // more checks graduate out of vision the more specific the emitted kind is.
      [
        "Prefer the most precise deterministic assertion kind you can ground from the above (fall back to text-contains only when nothing more specific grounds cleanly). Any \"role\" value must be a REAL ARIA role as Playwright's getByRole accepts it (img, not image; textbox, not textfield):",
        '  text-contains: { "kind":"text-contains", "text":"..." } - a substring must appear in the page\'s visible text',
        '  visible: { "kind":"visible", "testId"|"selector"|"role":"...", ... } - a specific element must be visible',
        '  count: { "kind":"count", "testId"|"selector"|"role":"...", "op":"eq|gte|lte|gt|lt", "value": N } - element count matches',
        '  url-matches: { "kind":"url-matches", "pattern":"...", "mode":"contains|regex" } - the current URL matches',
        '  attribute-equals: { "kind":"attribute-equals", "testId"|"selector"|"role":"...", "attribute":"...", "value":"..." } - an element\'s attribute equals a value'
      ].join("\n"),
      'Reply ONLY JSON: { "passed": true|false, "reasoning": "...", "assertion": { "kind": "...", ... } }'
    ]);
  }
  if (mode === "fix") {
    const fix = step?.__fix ?? {};
    const { __fix: _omit, ...failedStep } = step ?? {};
    return bounded([
      "You are the self-healing FIXER for a failed browser-automation step. Propose exactly ONE recovery patch.",
      `Failed step: ${clip(JSON.stringify(failedStep), JSON_CAP)}`,
      `Failure kind: ${fix.failureKind ?? "other"}\nFailure: ${clip(fix.error, JSON_CAP)}`,
      shot,
      header,
      a11y ? `Accessible elements:\n${a11y}` : "",
      [
        'Patch kinds (the ONLY valid values for "patch"):',
        "  insert_before - add newStep before the failed step, then retry it (e.g. dismiss an overlay first)",
        "  replace_current - replace the failed step with newStep",
        "  skip_current - drop the failed step and continue",
        "  pause_for_user - a human must act (CAPTCHA / MFA / payment); include userInstructions",
        "  abort - no page action can recover this"
      ].join("\n"),
      'newStep (insert_before/replace_current only) must be { "type":"browser"|"verify"|"navigate"|"wait", "description":"one concrete action" }.',
      "A verify failure usually cannot be repaired by page actions - prefer abort unless something visible (an overlay, a wrong route, an unloaded page) plausibly blocks the expected outcome.",
      'Reply ONLY JSON: { "patch":"insert_before|replace_current|skip_current|pause_for_user|abort", "reasoning":"...", "newStep":{...} (insert/replace only), "userInstructions":"..." (pause_for_user only) }'
    ]);
  }
  if (mode === "judge") {
    return bounded([
      "You are answering a QUALITATIVE judgment question about the current page - this is NOT a deterministic check; use your understanding of the content, not just element presence.",
      `Question: ${step?.description ?? ""}`,
      shot,
      `URL: ${clip(observation?.url, 500)}\nTitle: ${clip(observation?.title, 300)}`,
      observation?.bodyText ? `Page text:\n${String(observation.bodyText).slice(0, 4000)}` : `Accessible elements:\n${a11y}`,
      'Reply ONLY JSON: { "passed": true|false, "reasoning": "..." }'
    ]);
  }
  return bounded([
    "You are resolving a browser ACTION step into a single Playwright action. Use the accessible elements to ground it.",
    `Goal: ${step?.description ?? ""}`,
    shot,
    header,
    `Accessible elements (role: name):\n${a11y}`,
    'Reply ONLY JSON: { "kind":"click|fill|select|check|hover|press", "role":"button|link|textbox|...", "name":"the accessible name", "value":"(for fill/select/press)" }'
  ]);
}

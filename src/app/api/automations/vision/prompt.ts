// Pure prompt-building for the vision route - kept out of route.ts because
// Next.js's route-file export contract only allows HTTP method handlers + a
// small config export set (an extra named export fails `next typegen`).
// mode: "action" | "verify" | "judge" | "fix" (a bounded browser-plan patch).

// Every embedded field is bounded. A single a11y node's accessible name can
// carry an entire data table's text, and the gateway hard-fails on oversized
// messages. Clipping here keeps the call inside the envelope it can serve.
const NAME_CAP = 240;
const JSON_CAP = 2000;
const PROMPT_CAP = 200_000;

function clip(value: unknown, cap: number): string {
  const text = String(value ?? "");
  return text.length > cap
    ? `${text.slice(0, cap)} [...clipped ${text.length - cap} chars]`
    : text;
}

export function buildVisionPrompt(
  mode: string,
  observation: any,
  step: any,
  screenshotPath?: string | null
): string {
  const a11y = Array.isArray(observation?.a11y)
    ? observation.a11y
        .slice(0, 80)
        .map((node: any) => `${node.role}: ${clip(node.name, NAME_CAP)}`)
        .join("\n")
    : "";
  const header = [
    `URL: ${clip(observation?.url, 500)}`,
    `Title: ${clip(observation?.title, 300)}`,
    `Heading: ${clip(observation?.headingText, 300)}`
  ].join("\n");
  const screenshot = screenshotPath
    ? `A current screenshot is available at ${JSON.stringify(
        screenshotPath
      )}. You MUST use the Read tool to inspect it before answering; do not infer visual appearance from the accessibility tree alone.`
    : "";
  const bounded = (
    parts: Array<string | false | null | undefined>
  ): string => {
    const prompt = parts.filter(Boolean).join("\n\n");
    return prompt.length > PROMPT_CAP
      ? `${prompt.slice(
          0,
          PROMPT_CAP
        )}\n\n[...prompt clipped at ${PROMPT_CAP} chars - judge from what is above]`
      : prompt;
  };

  if (mode === "verify") {
    return bounded([
      "You are resolving a browser VERIFY step. Given the page state, decide if the expected outcome holds.",
      `Expected: ${step?.expectedOutcome ?? step?.description ?? ""}`,
      screenshot,
      header,
      `Accessible elements:\n${a11y}`,
      step?.areaHint
        ? `Known anchor for the element this step concerns: ${clip(
            JSON.stringify(step.areaHint),
            JSON_CAP
          )}`
        : "",
      [
        "Prefer the most precise deterministic assertion kind you can ground from the above (fall back to text-contains only when nothing more specific grounds cleanly). Any \"role\" value must be a REAL ARIA role as Playwright's getByRole accepts it (img, not image; textbox, not textfield):",
        '  text-contains: { "kind":"text-contains", "text":"..." } - a substring must appear in the page\'s visible text',
        '  visible: { "kind":"visible", "testId"|"selector"|"role":"...", ... } - a specific element must be visible',
        '  count: { "kind":"count", "testId"|"selector"|"role":"...", "op":"eq|gte|lte|gt|lt", "value": N } - element count matches',
        '  url-matches: { "kind":"url-matches", "pattern":"...", "mode":"contains|regex" } - the current URL matches',
        '  attribute-equals: { "kind":"attribute-equals", "testId"|"selector"|"role":"...", "attribute":"...", "value":"..." } - an element\'s attribute equals a value'
      ].join("\n"),
      'Reply ONLY valid single-line JSON (escape any newline inside strings): { "passed": true|false, "reasoning": "...", "assertion": { "kind": "...", ... } }'
    ]);
  }

  if (mode === "judge") {
    return bounded([
      "You are answering a QUALITATIVE judgment question about the current page - this is NOT a deterministic check; use your understanding of the content, not just element presence.",
      `Question: ${step?.description ?? ""}`,
      screenshot,
      `URL: ${clip(observation?.url, 500)}\nTitle: ${clip(
        observation?.title,
        300
      )}`,
      observation?.bodyText
        ? `Page text:\n${clip(observation.bodyText, 4000)}`
        : `Accessible elements:\n${a11y}`,
      'Reply ONLY valid single-line JSON (escape any newline inside strings): { "passed": true|false, "reasoning": "..." }'
    ]);
  }

  if (mode === "fix") {
    const failure = step?.__fix ?? {};
    const failingStep =
      step && typeof step === "object"
        ? Object.fromEntries(
            Object.entries(step).filter(([key]) => key !== "__fix")
          )
        : step;
    return bounded([
      "You are repairing ONE failed page-level browser automation step. Return a bounded PLAN PATCH, not a click/fill action.",
      `Failing step: ${clip(JSON.stringify(failingStep ?? {}), JSON_CAP)}`,
      `Failure kind: ${clip(failure.failureKind ?? "other", 200)}`,
      `Failure message: ${clip(
        failure.error ?? "unknown failure",
        JSON_CAP
      )}`,
      screenshot,
      header,
      a11y ? `Accessible elements (role: name):\n${a11y}` : "",
      [
        "Allowed patch kinds:",
        "- insert_before: add one browser, verify, navigate, or wait step before the failing step, then retry it.",
        "- replace_current: replace an incorrect or stale step with one browser, verify, navigate, or wait step.",
        "- skip_current: only when the check is provably redundant; never use it merely to make the run pass.",
        "- pause_for_user: only for an unavoidable human action.",
        "- abort: the product outcome is genuinely not met or no safe bounded recovery exists.",
        "A newStep may ONLY have type browser, verify, navigate, or wait. Never propose shell, API, connector, or sub-automation work.",
        "A verify failure usually cannot be repaired by page actions - prefer abort unless an overlay, wrong route, or unloaded page plausibly blocks the expected outcome."
      ].join("\n"),
      'Reply ONLY valid single-line JSON (escape any newline inside strings): { "patch":"insert_before|replace_current|skip_current|pause_for_user|abort", "reasoning":"...", "newStep": { "type":"browser|verify|navigate|wait", "...":"..." }, "userInstructions":"(pause_for_user only)" }'
    ]);
  }

  return bounded([
    "You are resolving a browser ACTION step into a single Playwright action. Use the accessible elements to ground it.",
    `Goal: ${step?.description ?? ""}`,
    screenshot,
    header,
    `Accessible elements (role: name):\n${a11y}`,
    'Reply ONLY valid single-line JSON (escape any newline inside strings): { "kind":"click|fill|select|check|hover|press", "role":"button|link|textbox|...", "name":"the accessible name", "value":"(for fill/select/press)" }'
  ]);
}

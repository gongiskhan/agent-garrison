// Compaction focus template (D4) + renderer.
//
// The authored default template lives HERE (in the http-gateway fitting) rather
// than as inline strings scattered across the controller. The gateway config
// `compact_focus_template` overrides it. {{placeholders}} are filled from a
// focusContext object; any line whose placeholder resolves to an empty value is
// dropped, so an EMPTY context renders a clean generic-session variant (the
// card/duty lines vanish, the preserve instruction stays).

export const DEFAULT_FOCUS_TEMPLATE = `Compaction focus - preserve the following context exactly; summarize everything else freely.

Active card: {{card_id}} - {{card_title}}
Current duty: {{duty}} (level {{level}})
Decisions made so far: {{decisions}}
Open items still to do: {{open_items}}
Files touched this run: {{files_touched}}
Pending steering from the user: {{steering}}

Do NOT drop the card id/title, the current duty and level, the decisions already made, the open items, the list of files touched, or any pending steering. Keep enough of the working context to continue the current duty without re-reading everything.`;

const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/gi;

function valueFor(ctx, key) {
  const v = ctx[key];
  if (v === undefined || v === null) return "";
  return typeof v === "string" ? v.trim() : String(v).trim();
}

/**
 * Render a focus template against a focusContext. A line carrying a placeholder
 * whose value is empty is dropped entirely (so an empty context yields the
 * generic variant); a line with all placeholders filled is substituted. Lines
 * with no placeholder pass through. Collapses blank runs and trims.
 */
export function renderFocusTemplate(template, focusContext = {}) {
  const tpl = typeof template === "string" && template.trim() ? template : DEFAULT_FOCUS_TEMPLATE;
  const ctx = focusContext && typeof focusContext === "object" ? focusContext : {};
  const out = [];
  for (const line of tpl.split("\n")) {
    const keys = [...line.matchAll(PLACEHOLDER)].map((m) => m[1]);
    if (keys.length === 0) {
      out.push(line);
      continue;
    }
    // Drop the whole line if ANY of its placeholders is empty (card/duty lines
    // pair id+title etc.; a half-filled line reads worse than an omitted one).
    if (keys.some((k) => valueFor(ctx, k) === "")) continue;
    out.push(line.replace(PLACEHOLDER, (_m, k) => valueFor(ctx, k)));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * A single-line digest of a rendered focus for the claude `/compact <text>`
 * command: the TUI takes trailing free text as the summarization focus, and a
 * multi-line command would break submission, so collapse whitespace and cap.
 */
export function focusDigest(text, max = 800) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) : s;
}

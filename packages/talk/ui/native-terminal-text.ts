// Strip terminal controls from untrusted transcript text. Only the presentation
// layer below emits escapes; a recorded tool result cannot issue terminal codes.
function safeText(value: unknown): string {
  return String(value ?? "").replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))?/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}
export function nativeTerminalEventText(entry: { role?: string; blocks?: Array<Record<string, unknown>> }): string {
  const sections: string[] = [];
  const heading = (label: string, text: string) => `\n\x1b[1;33m${label}\x1b[0m\n${text}\n`;
  for (const block of entry.blocks ?? []) {
    if (block.type === "text") sections.push(heading(entry.role === "user" ? "USER" : "AGENT", safeText(block.text)));
    if (block.type === "thinking") sections.push(heading("THINKING", safeText(block.text)));
    if (block.type === "tool_use") sections.push(heading("TOOL CALL", `$ ${safeText(block.name)}\n${safeText(block.input)}`));
    if (block.type === "tool_result" || block.type === "tool_progress") sections.push(heading(block.isError ? "TOOL ERROR" : "TOOL OUTPUT", safeText(block.text)));
  }
  return sections.join("");
}

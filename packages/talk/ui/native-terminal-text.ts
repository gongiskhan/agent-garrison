// Strip terminal controls from untrusted transcript text. Only the presentation
// layer below emits escapes; a recorded tool result cannot issue terminal codes.
function safeText(value: unknown): string {
  return String(value ?? "").replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))?/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}
export function nativeTerminalEventText(entry: { role?: string; blocks?: Array<Record<string, unknown>> }): string {
  const sections: string[] = [];
  for (const block of entry.blocks ?? []) {
    if (block.type === "text") sections.push(safeText(block.text));
    if (block.type === "thinking") sections.push(`Thinking\n${safeText(block.text)}`);
    if (block.type === "tool_use") sections.push(`$ ${safeText(block.name)}\n${safeText(block.input)}`);
    if (block.type === "tool_result") sections.push(`${block.isError ? "Error\n" : ""}${safeText(block.text)}`);
  }
  if (!sections.length) return "";
  const role = entry.role === "user" ? "USER" : "AGENT";
  return `\n\x1b[1;33m${role}\x1b[0m\n${sections.join("\n\n")}\n`;
}

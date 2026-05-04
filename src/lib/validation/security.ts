import { walkText } from "./fs-walk";
import type { ValidationCheck, ValidationContext } from "./index";

// Placeholder for an AI-driven security scanner. The real implementation
// lands in the runtime SDK milestone. For now we flag a small set of
// obvious red-flag patterns to give Fitting authors immediate signal.
const PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: "eval()", regex: /\beval\s*\(/ },
  { name: "child_process.exec with shell:true", regex: /child_process[\s\S]*?shell\s*:\s*true/ },
  { name: "Function() constructor", regex: /\bnew\s+Function\s*\(/ }
];

export async function runSecurityCheck(context: ValidationContext): Promise<ValidationCheck> {
  const notes: string[] = [];
  const errors: string[] = [];

  for await (const { relativePath, content } of walkText(context.fittingPath, [".ts", ".tsx", ".js", ".mjs", ".cjs"])) {
    for (const pattern of PATTERNS) {
      if (pattern.regex.test(content)) {
        errors.push(`${relativePath}: matches ${pattern.name}`);
      }
    }
  }

  if (errors.length === 0) {
    notes.push("no obvious red-flag patterns matched");
  }

  return {
    name: "security",
    passed: errors.length === 0,
    notes,
    errors
  };
}

import { walkText } from "./fs-walk";
import type { ValidationCheck, ValidationContext } from "./index";

// Placeholder for an AI-driven prompt-injection scanner. The real
// implementation lands in the runtime SDK milestone. For now we flag a
// small set of well-known textual injection patterns.
const PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: "IGNORE PREVIOUS INSTRUCTIONS", regex: /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i },
  { name: "[SYSTEM]: tag", regex: /\[\s*SYSTEM\s*\]\s*:/ },
  { name: "DAN-style jailbreak", regex: /do\s+anything\s+now/i }
];

export async function runPromptInjectionCheck(context: ValidationContext): Promise<ValidationCheck> {
  const notes: string[] = [];
  const errors: string[] = [];

  for await (const { relativePath, content } of walkText(context.fittingPath, [".md", ".markdown", ".txt"])) {
    for (const pattern of PATTERNS) {
      if (pattern.regex.test(content)) {
        errors.push(`${relativePath}: matches ${pattern.name}`);
      }
    }
  }

  if (errors.length === 0) {
    notes.push("no known injection patterns matched");
  }

  return {
    name: "prompt-injection",
    passed: errors.length === 0,
    notes,
    errors
  };
}

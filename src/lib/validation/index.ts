import path from "node:path";
import { runArchitectureCheck } from "./architecture";
import { runSecurityCheck } from "./security";
import { runPromptInjectionCheck } from "./prompt-injection";
import { runQualityCheck } from "./quality";

export type CheckName = "architecture" | "security" | "prompt-injection" | "quality";

export interface ValidationCheck {
  name: CheckName;
  passed: boolean;
  notes: string[];
  errors: string[];
}

export interface ValidationReport {
  fittingId: string;
  fittingPath: string;
  checks: ValidationCheck[];
  overall: "pass" | "fail";
  ranAt: string;
}

export interface ValidationContext {
  fittingPath: string;
  fittingId: string;
}

export async function validateFitting(fittingPath: string): Promise<ValidationReport> {
  const absolutePath = path.resolve(fittingPath);
  const architecture = await runArchitectureCheck(absolutePath);

  const fittingId = architecture.fittingId ?? path.basename(absolutePath);
  const context: ValidationContext = { fittingPath: absolutePath, fittingId };

  const [security, promptInjection, quality] = await Promise.all([
    runSecurityCheck(context),
    runPromptInjectionCheck(context),
    runQualityCheck(context, architecture.metadata)
  ]);

  const checks: ValidationCheck[] = [architecture.check, security, promptInjection, quality];
  const overall: "pass" | "fail" = checks.every((c) => c.passed) ? "pass" : "fail";

  return {
    fittingId,
    fittingPath: absolutePath,
    checks,
    overall,
    ranAt: new Date().toISOString()
  };
}

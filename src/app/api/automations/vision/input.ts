import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_SCREENSHOT_BASE64_BYTES = 24 * 1024 * 1024;

export function visionGatewayClassification(contextTag?: string) {
  const adversarial = contextTag === "drill-adversarial";
  return {
    taskType: "image" as const,
    tier: adversarial ? ("T2-deep" as const) : ("T1-standard" as const),
    contextKind: contextTag ? `automation-vision:${contextTag}` : "automation-vision",
    matchedException: adversarial
      ? "ex-automation-vision-adversarial"
      : "ex-automation-vision"
  };
}

function imageExtension(bytes: Buffer): "jpg" | "png" | "webp" | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes.subarray(1, 4).toString("ascii") === "PNG"
  ) {
    return "png";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

// Claude-backed routed sessions can inspect local images with their Read tool.
// Materialize the browser's screenshot under this instance's GARRISON_HOME for
// the duration of one gateway turn; the route removes it in a finally block.
export async function materializeVisionScreenshot(value: unknown): Promise<string | null> {
  if (typeof value !== "string" || value.trim() === "") return null;
  let payload = value.trim();
  const dataUri = payload.match(/^data:image\/(?:jpe?g|png|webp);base64,(.*)$/s);
  if (dataUri) payload = dataUri[1];
  payload = payload.replace(/\s+/g, "");
  if (payload.length === 0 || payload.length > MAX_SCREENSHOT_BASE64_BYTES) {
    throw new Error("screenshot payload is empty or too large");
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) {
    throw new Error("screenshot payload is not valid base64");
  }

  const bytes = Buffer.from(payload, "base64");
  const extension = imageExtension(bytes);
  if (!extension) {
    throw new Error("screenshot payload is not a supported JPEG, PNG, or WebP image");
  }

  const home = process.env.GARRISON_HOME?.trim() || path.join(os.homedir(), ".garrison");
  const dir = path.join(home, "automations", "vision-inputs");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const file = path.join(dir, `${crypto.randomUUID()}.${extension}`);
  await fs.writeFile(file, bytes, { mode: 0o600 });
  await fs.chmod(file, 0o600);
  return file;
}

export async function removeVisionScreenshot(file: string | null): Promise<void> {
  if (!file) return;
  await fs.rm(file, { force: true }).catch(() => {});
}

function firstBalancedObject(text: string): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (start < 0) {
      if (char !== "{") continue;
      start = index;
      depth = 1;
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function escapeStringControlCharacters(json: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (const char of json) {
    if (!inString) {
      output += char;
      if (char === '"') inString = true;
      continue;
    }
    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      output += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      output += char;
      inString = false;
      continue;
    }
    const code = char.charCodeAt(0);
    if (code <= 0x1f) {
      const named: Record<number, string> = {
        0x08: "\\b",
        0x09: "\\t",
        0x0a: "\\n",
        0x0c: "\\f",
        0x0d: "\\r"
      };
      output += named[code] ?? `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      output += char;
    }
  }
  return output;
}

function escapeUnambiguousInteriorQuotes(json: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < json.length; index += 1) {
    const char = json[index];
    if (!inString) {
      output += char;
      if (char === '"') inString = true;
      continue;
    }
    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      output += char;
      escaped = true;
      continue;
    }
    if (char !== '"') {
      output += char;
      continue;
    }

    let nextIndex = index + 1;
    while (nextIndex < json.length && /\s/.test(json[nextIndex])) nextIndex += 1;
    const next = json[nextIndex];
    if (next === undefined || next === ":" || next === "," || next === "}" || next === "]") {
      output += char;
      inString = false;
    } else {
      // Claude's terminal renderer can remove the backslash from an escaped
      // quote in prose (for example lang="pt-PT"). A quote followed by prose
      // cannot legally close a JSON string, so this repair is unambiguous.
      output += '\\"';
    }
  }
  return output;
}

// Model replies occasionally contain a literal newline inside a JSON string.
// Claude's terminal renderer can also strip the slash from an escaped quote.
// Repair only quotes that cannot legally terminate a JSON string and forbidden
// control characters inside strings; structural damage remains a hard failure.
export function parseVisionModelReply(text: unknown): Record<string, unknown> {
  if (typeof text !== "string") {
    throw new Error("vision reply was not text");
  }
  const candidate = firstBalancedObject(text);
  if (!candidate) {
    throw new Error("vision reply had no complete JSON object");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (firstError) {
    const repairedQuotes = escapeUnambiguousInteriorQuotes(candidate);
    const repaired = escapeStringControlCharacters(repairedQuotes);
    if (repaired === candidate) {
      const detail = firstError instanceof Error ? firstError.message : String(firstError);
      throw new Error(`vision reply contained invalid JSON: ${detail}`);
    }
    try {
      parsed = JSON.parse(repaired);
    } catch (secondError) {
      const detail = secondError instanceof Error ? secondError.message : String(secondError);
      throw new Error(`vision reply contained invalid JSON: ${detail}`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("vision reply JSON must be an object");
  }
  return parsed as Record<string, unknown>;
}

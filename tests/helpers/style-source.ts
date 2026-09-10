import { readFileSync } from "node:fs";
import path from "node:path";

// Inline the same local imports as the UI build when a fixture injects CSS.
export function styleSource(file: string): string {
  return readFileSync(file, "utf8").replace(/^@import "([^"]+)";\n/gm,
    (_line, relative) => styleSource(path.resolve(path.dirname(file), relative)));
}

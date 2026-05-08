// Shared helpers for the three variants.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export async function makeTempProject(label) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(os.tmpdir(), `garrison-spike-${label}-${stamp}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "README.md"),
    "# Spike Project\n\nA disposable project used by the Phase 4 sub-agent spike.\n"
  );
  return dir;
}

export async function cleanup(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

export async function readReadme(dir) {
  return fs.readFile(path.join(dir, "README.md"), "utf8");
}

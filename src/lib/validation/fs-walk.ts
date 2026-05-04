import fs from "node:fs/promises";
import path from "node:path";

const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "apm_modules", "dist", "build"]);

export interface TextFile {
  absolutePath: string;
  relativePath: string;
  content: string;
}

export async function* walkText(
  rootDir: string,
  extensions: readonly string[]
): AsyncGenerator<TextFile> {
  yield* walk(rootDir, rootDir, extensions);
}

async function* walk(
  baseDir: string,
  currentDir: string,
  extensions: readonly string[]
): AsyncGenerator<TextFile> {
  let entries;
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const name = entry.name.toString();
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(name)) {
        continue;
      }
      yield* walk(baseDir, path.join(currentDir, name), extensions);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const ext = path.extname(name).toLowerCase();
    if (!extensions.includes(ext)) {
      continue;
    }
    const absolutePath = path.join(currentDir, name);
    const relativePath = path.relative(baseDir, absolutePath);
    let content: string;
    try {
      content = await fs.readFile(absolutePath, "utf8");
    } catch {
      continue;
    }
    yield { absolutePath, relativePath, content };
  }
}

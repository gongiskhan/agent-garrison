import fs from "node:fs/promises";
import yaml from "js-yaml";

export async function readYamlFile<T = unknown>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    if (!raw.trim()) {
      return null;
    }
    return yaml.load(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function writeYamlFile(filePath: string, value: unknown): Promise<void> {
  const raw = yaml.dump(value, {
    lineWidth: 100,
    noRefs: true,
    sortKeys: false
  });
  await fs.writeFile(filePath, raw, "utf8");
}

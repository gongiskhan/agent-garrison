import fs from "node:fs/promises";
import path from "node:path";
import { readCompositionWithDerivedTasks } from "./compositions";

export interface ArtifactMeta {
  id: string;
  filename: string;
  namespace: string;
  producer?: string;
  mime: string;
  title?: string;
  created?: string;
  updated?: string;
}

const META_SUFFIX = ".meta.json";

export async function resolveArtifactRoot(
  compositionId?: string
): Promise<string> {
  const composition = await readCompositionWithDerivedTasks(compositionId);
  const selections = composition.selections["artifact-store"] ?? [];
  const selection = selections[0];
  const relative =
    (selection?.config?.storage_root as string | undefined) ?? "artifacts";
  return path.resolve(composition.directory, relative);
}

export async function listArtifacts(
  compositionId?: string
): Promise<ArtifactMeta[]> {
  const root = await resolveArtifactRoot(compositionId);
  const namespaces = await safeReaddir(root);
  const results: ArtifactMeta[] = [];
  for (const namespace of namespaces) {
    const namespaceDir = path.join(root, namespace);
    const stat = await fs.stat(namespaceDir).catch(() => null);
    if (!stat?.isDirectory()) continue;
    const files = await safeReaddir(namespaceDir);
    for (const file of files) {
      if (!file.endsWith(META_SUFFIX)) continue;
      const sidecarPath = path.join(namespaceDir, file);
      try {
        const raw = await fs.readFile(sidecarPath, "utf8");
        const meta = JSON.parse(raw) as ArtifactMeta;
        if (meta.id) {
          results.push(meta);
        }
      } catch {
        // Skip malformed sidecars rather than 500 the whole listing.
      }
    }
  }
  results.sort((a, b) => {
    const aKey = a.updated ?? a.created ?? "";
    const bKey = b.updated ?? b.created ?? "";
    return bKey.localeCompare(aKey);
  });
  return results;
}

export interface FoundArtifact {
  meta: ArtifactMeta;
  artifactPath: string;
  sidecarPath: string;
}

export async function findArtifact(
  id: string,
  compositionId?: string
): Promise<FoundArtifact | null> {
  const root = await resolveArtifactRoot(compositionId);
  const namespaces = await safeReaddir(root);
  for (const namespace of namespaces) {
    const namespaceDir = path.join(root, namespace);
    const files = await safeReaddir(namespaceDir);
    for (const file of files) {
      if (!file.endsWith(META_SUFFIX)) continue;
      const sidecarPath = path.join(namespaceDir, file);
      try {
        const meta = JSON.parse(
          await fs.readFile(sidecarPath, "utf8")
        ) as ArtifactMeta;
        if (meta.id === id) {
          const artifactPath = path.join(
            namespaceDir,
            file.slice(0, -META_SUFFIX.length)
          );
          return { meta, artifactPath, sidecarPath };
        }
      } catch {
        // ignore
      }
    }
  }
  return null;
}

export async function deleteArtifact(
  id: string,
  compositionId?: string
): Promise<boolean> {
  const found = await findArtifact(id, compositionId);
  if (!found) return false;
  await Promise.all([
    fs.rm(found.artifactPath, { force: true }),
    fs.rm(found.sidecarPath, { force: true })
  ]);
  return true;
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

import { describe, expect, it } from "vitest";

// Pure-unit tests for the vault-sync diff algorithm logic.
// We replicate the relevant diff logic here (source of truth is sync.py)
// to keep CI fast without spawning a Python subprocess.

interface FileInfo {
  size: number;
  mtime: number;
}

function diff(
  local: Record<string, FileInfo>,
  remote: Record<string, FileInfo>
): {
  toUpload: string[];
  toDelete: string[];
  toSkip: string[];
} {
  const localKeys = new Set(Object.keys(local));
  const remoteKeys = new Set(Object.keys(remote));

  const toDelete = [...remoteKeys].filter((k) => !localKeys.has(k));
  const toUpload: string[] = [];
  const toSkip: string[] = [];

  for (const relpath of localKeys) {
    const rinfo = remote[relpath];
    if (rinfo === undefined) {
      toUpload.push(relpath);
    } else if (local[relpath].size !== rinfo.size || Math.abs(local[relpath].mtime - rinfo.mtime) > 1.0) {
      toUpload.push(relpath);
    } else {
      toSkip.push(relpath);
    }
  }

  return { toUpload, toDelete, toSkip };
}

describe("vault-sync diff algorithm", () => {
  it("uploads new local files not on remote", () => {
    const result = diff(
      { "notes/idea.md": { size: 100, mtime: 1000 } },
      {}
    );
    expect(result.toUpload).toContain("notes/idea.md");
    expect(result.toDelete).toHaveLength(0);
    expect(result.toSkip).toHaveLength(0);
  });

  it("deletes remote files not in local", () => {
    const result = diff({}, { "old/file.md": { size: 50, mtime: 900 } });
    expect(result.toDelete).toContain("old/file.md");
    expect(result.toUpload).toHaveLength(0);
  });

  it("skips files with matching size and mtime", () => {
    const result = diff(
      { "same.md": { size: 200, mtime: 1500 } },
      { "same.md": { size: 200, mtime: 1500 } }
    );
    expect(result.toSkip).toContain("same.md");
    expect(result.toUpload).toHaveLength(0);
    expect(result.toDelete).toHaveLength(0);
  });

  it("re-uploads when size differs", () => {
    const result = diff(
      { "changed.md": { size: 300, mtime: 1500 } },
      { "changed.md": { size: 200, mtime: 1500 } }
    );
    expect(result.toUpload).toContain("changed.md");
  });

  it("re-uploads when mtime differs by more than 1 second", () => {
    const result = diff(
      { "updated.md": { size: 200, mtime: 1502 } },
      { "updated.md": { size: 200, mtime: 1500 } }
    );
    expect(result.toUpload).toContain("updated.md");
  });

  it("skips when mtime differs by <= 1 second (filesystem rounding)", () => {
    const result = diff(
      { "rounding.md": { size: 200, mtime: 1500.5 } },
      { "rounding.md": { size: 200, mtime: 1500 } }
    );
    expect(result.toSkip).toContain("rounding.md");
  });

  it("handles a mixed batch correctly", () => {
    const result = diff(
      {
        "keep.md": { size: 100, mtime: 1000 },
        "update.md": { size: 200, mtime: 2000 },
        "new.md": { size: 50, mtime: 3000 },
      },
      {
        "keep.md": { size: 100, mtime: 1000 },
        "update.md": { size: 150, mtime: 2000 },
        "stale.md": { size: 80, mtime: 500 },
      }
    );
    expect(result.toSkip).toContain("keep.md");
    expect(result.toUpload).toContain("update.md");
    expect(result.toUpload).toContain("new.md");
    expect(result.toDelete).toContain("stale.md");
  });
});

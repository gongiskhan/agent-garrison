// One way to write a composition manifest, and it keeps the prose (D63).
//
// Muster had two persist paths: one that pushed the edit to the mesh state
// service, and the one nine of the ten mutations used, which wrote the local
// file and stopped there. The state service is the source of truth, so those
// edits were reverted on the next up() of any node that materialises from it -
// silently, with a 200 on the way out. Both paths also dumped the parsed
// manifest through js-yaml, which cannot keep comments, so the first write
// after any hand-edit stripped every line of prose from the manifest mesh-wide.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDocument } from "yaml";

const pushed: Array<{ id: string; yaml: string }> = [];
let pushFails: string | null = null;
vi.mock("@/lib/composition-sync", () => ({
  pushManifestToState: async (id: string, yaml: string) => {
    if (pushFails) throw new Error(pushFails);
    pushed.push({ id, yaml });
    return { pushed: true, rev: pushed.length };
  }
}));

const { applyManifestDiff, persistManifest } = await import("@/lib/manifest-write");

const MANIFEST = `name: default
version: 0.1.0
x-garrison:
  composition:
    # Why the wake word is what it is: the operative answers to Zeca, and the
    # variants are the renderings Deepgram actually returns.
    selections:
      channels:
        - id: capture-service
          config:
            # The Record button captures the screen only; the words reach Zeca
            # through the pendant or the Listen button.
            screen_audio_transcribe: false
    duties:
      - id: discuss
        title: Discuss
    # Selecting a duty is what makes it legal as a handoff target.
    selected_duties:
      - discuss
`;

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "manifest-write-"));
  const file = path.join(dir, "apm.yml");
  writeFileSync(file, MANIFEST);
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

beforeEach(() => {
  pushed.length = 0;
  pushFails = null;
});

describe("applyManifestDiff", () => {
  it("touches only what changed, so every untouched comment survives", () => {
    const doc = parseDocument(MANIFEST);
    const before = doc.toJS();
    const after = structuredClone(before);
    after["x-garrison"].composition.selected_duties = ["discuss", "dialogue"];
    const changes = applyManifestDiff(doc, before, after);
    expect(changes).toBe(1);
    const out = doc.toString();
    expect(out).toContain("- dialogue");
    expect(out, "the comment above the edited key stays").toContain("Selecting a duty is what makes it legal");
    expect(out, "and so does every other one").toContain("the operative answers to Zeca");
    expect(out).toContain("The Record button captures the screen only");
  });

  it("edits a deep scalar in place and leaves its comment attached", () => {
    const doc = parseDocument(MANIFEST);
    const before = doc.toJS();
    const after = structuredClone(before);
    after["x-garrison"].composition.selections.channels[0].config.screen_audio_transcribe = true;
    expect(applyManifestDiff(doc, before, after)).toBe(1);
    const out = doc.toString();
    expect(out).toContain("screen_audio_transcribe: true");
    expect(out).toContain("The Record button captures the screen only");
  });

  it("appends to a list without rewriting the elements already in it", () => {
    const doc = parseDocument(MANIFEST);
    const before = doc.toJS();
    const after = structuredClone(before);
    after["x-garrison"].composition.duties.push({ id: "dialogue", title: "Dialogue" });
    expect(applyManifestDiff(doc, before, after)).toBe(1);
    const out = doc.toString();
    expect(out).toContain("id: dialogue");
    expect(out).toContain("id: discuss");
    expect(out, "a sibling list's prose is untouched").toContain("The Record button captures the screen only");
  });

  it("deletes a removed key", () => {
    const doc = parseDocument(MANIFEST);
    const before = doc.toJS();
    const after = structuredClone(before);
    delete after.version;
    expect(applyManifestDiff(doc, before, after)).toBe(1);
    expect(doc.toString()).not.toContain("version: 0.1.0");
  });

  it("is a no-op when nothing changed - an idle write must not rewrite the file", () => {
    const doc = parseDocument(MANIFEST);
    const before = doc.toJS();
    expect(applyManifestDiff(doc, before, structuredClone(before))).toBe(0);
    expect(doc.toString()).toBe(MANIFEST);
  });
});

describe("persistManifest", () => {
  it("writes the comment-preserving form AND pushes the same bytes to the mesh", async () => {
    const f = fixture();
    try {
      const doc = parseDocument(MANIFEST);
      const before = doc.toJS();
      const after = structuredClone(before);
      after["x-garrison"].composition.selected_duties = ["discuss", "dialogue"];
      const out = await persistManifest("default", f.file, before, after);
      expect(out.pushed).toBe(true);
      const onDisk = readFileSync(f.file, "utf8");
      expect(onDisk).toContain("- dialogue");
      expect(onDisk).toContain("Selecting a duty is what makes it legal");
      expect(pushed).toHaveLength(1);
      expect(pushed[0], "the mesh gets exactly what the node has").toMatchObject({ id: "default", yaml: onDisk });
    } finally {
      f.cleanup();
    }
  });

  it("fails LOUDLY when the edit cannot reach shared state - a silent fork is the worse outcome", async () => {
    const f = fixture();
    pushFails = "state api 503";
    try {
      const doc = parseDocument(MANIFEST);
      const before = doc.toJS();
      const after = structuredClone(before);
      after["x-garrison"].composition.selected_duties = [];
      await expect(persistManifest("default", f.file, before, after)).rejects.toThrow(
        /NOT to the mesh state service/
      );
    } finally {
      f.cleanup();
    }
  });
});

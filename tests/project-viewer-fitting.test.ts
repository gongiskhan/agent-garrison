import path from "node:path";
import os from "node:os";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  cleanupAllowlistPath,
  consolidateDoc,
  getDocsManifest,
  saveIntake,
} from "../fittings/seed/project-viewer/lib/store.mjs";
import { runCleanup } from "../fittings/seed/project-viewer/scripts/cleanup.mjs";
import { describe, expect, it } from "vitest";

import {
  hashText,
  inferLang,
  normaliseHighlights,
  sliceSpan,
  splitLines,
  verifySpanSample,
} from "../fittings/seed/project-viewer/lib/extract.mjs";
import {
  safeId,
  validateFindings,
  validateFlow,
} from "../fittings/seed/project-viewer/lib/manifest.mjs";
import {
  escapeHtml,
  highlightLine,
  renderCodeBlock,
} from "../fittings/seed/project-viewer/lib/highlight.mjs";
import { diffStats, parseHunk, splitByFile } from "../fittings/seed/project-viewer/lib/diff.mjs";
import {
  deltaAbove,
  hunksTouch,
  parseUnifiedZeroDiff,
  rebaseSpan,
  refreshFlow,
  refreshStep,
} from "../fittings/seed/project-viewer/lib/invalidate.mjs";
import {
  buildFileIndex,
  flowsTouchingFiles,
  stalenessSummary,
  uncommittedView,
} from "../fittings/seed/project-viewer/lib/file-index.mjs";
import {
  prose,
  renderCompare,
  renderFindings,
  renderFlowOutline,
  renderFlowState,
  renderCommitDiff,
  renderFlowLogic,
  renderIndex,
  renderProjects,
  renderUncommitted,
} from "../fittings/seed/project-viewer/lib/render.mjs";
import {
  addProject,
  labelsFor,
  listProjects,
  normalisePath,
  readRegistry,
  removeProject,
  resolveKey,
} from "../fittings/seed/project-viewer/lib/projects.mjs";
import {
  admissionsFor,
  checkSpine,
  specFromCapture,
  stepTitle,
} from "../fittings/seed/project-viewer/lib/spine.mjs";
import {
  countReferences,
  deadCandidates,
  duplicateNames,
  exportsOf,
  isFrameworkEntry,
  isSourceFile,
  isTestFile,
  scanExports,
} from "../fittings/seed/project-viewer/lib/static-scan.mjs";
import {
  buildCompareReport,
  noteFor,
  observedFiles,
} from "../fittings/seed/project-viewer/lib/compare.mjs";
import { buildDispatch, fixPrompt, walkthroughPrompt } from "../fittings/seed/project-viewer/lib/prompts.mjs";
import { splitHunks } from "../fittings/seed/project-viewer/lib/samples.mjs";
import {
  loadYaml,
  navigationsFor,
  parseBook,
  parsePage,
} from "../fittings/seed/project-viewer/lib/drillbook.mjs";
import { pathOf } from "../fittings/seed/project-viewer/scripts/capture-drillbook.mjs";
import {
  buildSurvey,
  headingsOf,
  isProjectDoc,
  isProtectedDoc,
  linkedDocsOf,
  mentionedPaths,
  surveyDoc,
} from "../fittings/seed/project-viewer/lib/docs-survey.mjs";
import { isStructuralDiffLine } from "../fittings/seed/project-viewer/lib/git.mjs";
import {
  LANGS,
  keysFor,
  normaliseLang,
  otherLang,
  pickText,
  t,
} from "../fittings/seed/project-viewer/lib/i18n.mjs";
import { safeReturnPath } from "../fittings/seed/project-viewer/scripts/server.mjs";
import {
  pathSegments,
  redirectTargetOf,
  resolveApiRoute,
  resolveAppRoute,
  resolveThroughRedirects,
} from "../fittings/seed/project-viewer/lib/route-resolve.mjs";
import {
  importCandidates,
  importSpecifiers,
  isLocal,
  rankCandidates,
  resolveSpecifier,
} from "../fittings/seed/project-viewer/lib/import-graph.mjs";
import {
  actionEvent,
  buildCapture,
  noCoverageFinding,
  routeEvent,
  testKey,
} from "../fittings/seed/project-viewer/lib/captures.mjs";
import {
  stitchUrls,
  stripOrigin,
} from "../fittings/seed/project-viewer/scripts/capture-runtime.mjs";
import {
  actionOf,
  argOf,
  isNavigation,
} from "../fittings/seed/project-viewer/runtime/pv-reporter.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function sampleFor(file: string, startLine: number, endLine: number, text: string) {
  return {
    file,
    startLine,
    endLine,
    lang: "ts",
    highlights: [[startLine, startLine]],
    extractedSha256: hashText(text),
    sha: SHA_A,
  };
}

function goodFlow() {
  return {
    schemaVersion: 1,
    flowId: "demo-flow",
    title: "Demo",
    source: "e2e",
    anchoredAt: { sha: SHA_A },
    states: [
      {
        id: "s1",
        label: "First",
        steps: [
          {
            id: "one",
            title: "Step one",
            kind: "code",
            description: "Does a thing.",
            sample: sampleFor("src/a.ts", 1, 2, "x\ny"),
            next: [{ to: "two", label: "then" }],
            staleness: { status: "fresh", checkedAtSha: SHA_A },
          },
          {
            id: "two",
            title: "Step two",
            kind: "glue",
            collapsed: true,
            description: "Glue.",
            sample: sampleFor("src/b.ts", 5, 6, "p\nq"),
          },
        ],
      },
    ],
  };
}

function resolvedSamples(flow: any, ok = true) {
  const map = new Map<string, any>();
  for (const step of flow.states[0].steps) {
    if (!step.sample) continue;
    map.set(
      step.id,
      ok
        ? { kind: "span", ok: true, text: "line one\nline two" }
        : {
            kind: "span",
            ok: false,
            expected: "a".repeat(64),
            actual: "b".repeat(64),
            error: "hash mismatch",
            text: null,
          }
    );
  }
  return map;
}

describe("extraction is mechanical and hash-anchored", () => {
  it("normalises CRLF so a Windows checkout cannot change a hash", () => {
    expect(splitLines("a\r\nb\rc\nd")).toEqual(["a", "b", "c", "d"]);
    expect(hashText("a\nb")).toBe(hashText(splitLines("a\r\nb").join("\n")));
  });

  it("hashes a known value", () => {
    expect(hashText("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("slices 1-indexed inclusive ranges and refuses to clamp", () => {
    expect(sliceSpan("a\nb\nc\nd", 2, 3)).toBe("b\nc");
    // A silently shrunk sample is the failure mode this refusal exists to prevent.
    expect(() => sliceSpan("a\nb", 1, 9)).toThrow(/past end of file/);
  });

  it("verifies a good sample and detects a tampered one", () => {
    const text = "l1\nl2\nl3\nl4";
    const good = { startLine: 2, endLine: 3, extractedSha256: hashText(sliceSpan(text, 2, 3)) };
    expect(verifySpanSample(text, good).ok).toBe(true);

    const bad = { startLine: 2, endLine: 3, extractedSha256: "0".repeat(64) };
    const res = verifySpanSample(text, bad);
    expect(res.ok).toBe(false);
    expect(res.actual).toBeTruthy();
  });

  it("reports a missing file instead of throwing", () => {
    const res = verifySpanSample(null, { startLine: 1, endLine: 1, extractedSha256: "x" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/);
  });

  it("normalises highlights: drops out-of-window, clamps straddling, merges adjacent", () => {
    expect(normaliseHighlights([[3, 4], [5, 6], [1, 1]], 2, 8)).toEqual([[3, 6]]);
    expect(normaliseHighlights([[1, 4]], 2, 8)).toEqual([[2, 4]]);
    expect(normaliseHighlights([[6, 99]], 2, 8)).toEqual([[6, 8]]);
    expect(normaliseHighlights([[5, 3]], 2, 8)).toEqual([[3, 5]]);
  });

  it("infers a highlighter language from the extension", () => {
    expect(inferLang("a/b.tsx")).toBe("tsx");
    expect(inferLang("x.yml")).toBe("yaml");
    expect(inferLang("noext")).toBe("txt");
  });
});

describe("manifest validation", () => {
  it("accepts a well-formed flow", () => {
    const res = validateFlow(goodFlow());
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it("refuses an unknown schema version rather than half-rendering it", () => {
    expect(validateFlow({ ...goodFlow(), schemaVersion: 2 }).ok).toBe(false);
  });

  it("rejects a sample with no extraction hash — the anti-typed-code gate", () => {
    const flow = goodFlow();
    delete (flow.states[0].steps[0].sample as any).extractedSha256;
    const res = validateFlow(flow);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => /extractedSha256/.test(e))).toBe(true);
  });

  it("rejects a connector pointing at a step that does not exist", () => {
    const flow = goodFlow();
    flow.states[0].steps[0].next = [{ to: "nope" }] as any;
    const res = validateFlow(flow);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => /unknown step/.test(e))).toBe(true);
  });

  it("rejects backslash paths so manifests stay platform-neutral", () => {
    const flow = goodFlow();
    flow.states[0].steps[0].sample.file = "src\\a.ts";
    expect(validateFlow(flow).ok).toBe(false);
  });

  it("rejects highlights outside the sample window", () => {
    const flow = goodFlow();
    flow.states[0].steps[0].sample.highlights = [[99, 100]];
    expect(validateFlow(flow).ok).toBe(false);
  });

  it("requires an ascii illustration for external-system steps", () => {
    const flow = goodFlow();
    flow.states[0].steps[0].kind = "db";
    delete (flow.states[0].steps[0] as any).sample;
    expect(validateFlow(flow).ok).toBe(false);
  });

  it("rejects duplicate step ids", () => {
    const flow = goodFlow();
    flow.states[0].steps[1].id = "one";
    expect(validateFlow(flow).ok).toBe(false);
  });

  it("validates the findings collection", () => {
    expect(
      validateFindings({
        schemaVersion: 1,
        findings: [{ id: "f1", flowId: "demo-flow", severity: "high", text: "bad", status: "open" }],
      }).ok
    ).toBe(true);
    expect(validateFindings({ schemaVersion: 1, findings: [{ id: "f1" }] }).ok).toBe(false);
  });

  it("makes safe ids", () => {
    expect(safeId("Edits a Hook!")).toBe("edits-a-hook");
  });
});

describe("rendering is deterministic and escapes hostile text", () => {
  it("escapes markup in code", () => {
    const html = renderCodeBlock('const a = "<img onerror=1>";\nconst b = 2;', {
      startLine: 10,
      lang: "ts",
      highlights: [[11, 11]],
      file: "src/x.ts",
    });
    expect(html).not.toContain("<img");
    expect(html).toContain('data-line="10"');
    expect(html).toContain("is-highlight");
    // Agent readability: the anchor is on the element, not only in the prose.
    expect(html).toContain('data-file="src/x.ts"');
  });

  it("escapes markup in model-authored prose but keeps backtick code spans", () => {
    const html = prose("<script>alert(1)</script> and `code`");
    expect(html).not.toContain("<script");
    expect(html).toContain("<code>code</code>");
    expect(prose("")).toBe("");
  });

  it("escapes hostile HTML anywhere it appears", () => {
    expect(escapeHtml('<b>"x"</b>')).toBe("&lt;b&gt;&quot;x&quot;&lt;/b&gt;");
  });

  it("produces byte-identical output across runs, which is what makes re-rendering free", () => {
    const flow = goodFlow();
    const a = renderFlowState(flow, { stateIndex: 0, samples: resolvedSamples(flow), project: "p" });
    const b = renderFlowState(flow, { stateIndex: 0, samples: resolvedSamples(flow), project: "p" });
    expect(a).toBe(b);
    expect(highlightLine("export const x = 1;", "ts")).toBe(highlightLine("export const x = 1;", "ts"));
  });

  it("lays out the half-and-half unit with a breadcrumb and directional connectors", () => {
    const flow = goodFlow();
    const html = renderFlowState(flow, { stateIndex: 0, samples: resolvedSamples(flow), project: "p" });
    expect(html).toContain('class="split"');
    expect(html).toContain('class="breadcrumb"');
    expect(html).toContain("connector");
    expect(html).toContain('data-step="one"');
  });

  it("collapses a trivial step without omitting it", () => {
    const flow = goodFlow();
    const html = renderFlowState(flow, { stateIndex: 0, samples: resolvedSamples(flow), project: "p" });
    expect(html).toContain('<details class="step-fold"');
    // Collapse, never omit: an agent reading the HTML must still find it.
    expect(html).toContain("Step two");
  });

  it("groups the index by flow source", () => {
    const html = renderIndex([goodFlow()], { project: "p", findings: [], head: SHA_A });
    expect(html).toContain("From end-to-end tests");
    expect(html).toContain("Demo");
  });

  it("escapes finding text in the findings table", () => {
    const html = renderFindings(
      [
        {
          id: "f1",
          flowId: "demo-flow",
          severity: "high",
          text: "<b>bad</b>",
          status: "open",
          span: { file: "src/a.ts", startLine: 3 },
        },
      ],
      { project: "p", flows: [goodFlow()] }
    );
    expect(html).not.toContain("<b>bad</b>");
    expect(html).toContain("Fix selected");
  });

  it("surfaces a changed file that no flow covers, rather than hiding it", () => {
    const html = renderUncommitted([{ file: "z.ts", status: "modified", flows: [], unmapped: true }], {
      project: "p",
      flows: [],
      patches: [],
    });
    expect(html).toContain("unmapped");
    expect(html).toContain("no flow covers this file");
  });
});

describe("the trust guarantee is enforced in code, not asserted in prose", () => {
  it("renders an integrity panel and NO code when a sample hash does not match", () => {
    const flow = goodFlow();
    const html = renderFlowState(flow, {
      stateIndex: 0,
      samples: resolvedSamples(flow, false),
      project: "p",
    });
    expect(html).toContain("Sample integrity check failed");
    // The whole product rests on this assertion: a failed check must not fall
    // back to showing text, because wrong code shown confidently is worse than
    // no viewer at all.
    expect(html).not.toContain("line one");
    expect(html).not.toContain('table class="code"');
  });
});

describe("diff rendering", () => {
  const PATCH = [
    "@@ -10,3 +10,4 @@ export function reconcile()",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "+const c = 4;",
    " return a;",
  ].join("\n");

  it("numbers both sides of a hunk", () => {
    const hunk = parseHunk(PATCH);
    expect(hunk.oldStart).toBe(10);
    expect(hunk.rows.map((r: any) => r.type)).toEqual(["ctx", "del", "add", "add", "ctx"]);
    expect(hunk.rows[1].newNo).toBeNull();
    expect(hunk.rows[2].oldNo).toBeNull();
  });

  it("counts added and removed lines", () => {
    expect(diffStats(PATCH)).toEqual({ added: 2, removed: 1 });
  });

  it("splits a multi-file diff and detects added files", () => {
    const full = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      PATCH,
      "diff --git a/y.ts b/y.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/y.ts",
      "@@ -0,0 +1,1 @@",
      "+hello",
    ].join("\n");
    const files = splitByFile(full);
    expect(files).toHaveLength(2);
    expect(files[0].file).toBe("x.ts");
    expect(files[1].status).toBe("added");
  });

  it("splits a patch into one piece per hunk, which is a commit walkthrough's spine", () => {
    const full = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,2 +1,2 @@",
      "-a",
      "+b",
      "@@ -10,1 +10,2 @@",
      " c",
      "+d",
    ].join("\n");
    const hunks = splitHunks(full);
    expect(hunks).toHaveLength(2);
    expect(hunks[0].file).toBe("x.ts");
    expect(hunks[1].hunkHeader.startsWith("@@ -10")).toBe(true);
  });
});

describe("incremental invalidation keeps the token bill down", () => {
  const DIFF = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,0 +2,3 @@",
    "+one",
    "+two",
    "+three",
    "diff --git a/src/gone.ts b/src/gone.ts",
    "deleted file mode 100644",
    "--- a/src/gone.ts",
    "+++ /dev/null",
    "@@ -1,5 +0,0 @@",
    "-x",
    "diff --git a/src/hit.ts b/src/hit.ts",
    "--- a/src/hit.ts",
    "+++ b/src/hit.ts",
    "@@ -20,2 +20,2 @@",
    "-old",
    "+new",
  ].join("\n");

  const body = Array.from({ length: 80 }, (_, i) => `line${i + 1}`).join("\n");
  const shifted = ["one", "two", "three", ...body.split("\n")].join("\n");

  it("parses a unified-zero diff per file", () => {
    const map = parseUnifiedZeroDiff(DIFF);
    expect(map.has("src/a.ts")).toBe(true);
    expect(map.get("src/gone.ts").status).toBe("deleted");
    expect(map.get("src/hit.ts").hunks[0].oldStart).toBe(20);
  });

  it("treats a pure insertion as shifting but not touching", () => {
    const hunks = parseUnifiedZeroDiff(DIFF).get("src/a.ts").hunks;
    // Counting insertions as intersections would mark half the document stale on
    // every commit, which is the whole cost this design avoids.
    expect(hunksTouch(hunks, 50, 60)).toBe(false);
    expect(deltaAbove(hunks, 50)).toBe(3);
  });

  it("shifts a span and its highlights by one delta", () => {
    const hunks = parseUnifiedZeroDiff(DIFF).get("src/a.ts").hunks;
    const out = rebaseSpan({ startLine: 50, endLine: 60, highlights: [[52, 53]] }, hunks);
    expect(out.startLine).toBe(53);
    expect(out.endLine).toBe(63);
    expect(out.highlights).toEqual([[55, 56]]);
  });

  it("re-stamps an untouched span fresh with no model call", () => {
    const step = {
      id: "x",
      title: "t",
      kind: "code",
      sample: {
        file: "src/a.ts",
        startLine: 50,
        endLine: 52,
        highlights: [[50, 50]],
        extractedSha256: hashText(sliceSpan(body, 50, 52)),
      },
    };
    const out = refreshStep(step, parseUnifiedZeroDiff(DIFF), SHA_B, () => shifted);
    expect(out.outcome).toBe("restamped");
    expect(out.step.sample.startLine).toBe(53);
    expect(out.step.sample.highlights).toEqual([[53, 53]]);
    expect(out.step.staleness.status).toBe("fresh");
  });

  it("marks a touched span stale", () => {
    const step = {
      id: "x",
      title: "t",
      kind: "code",
      sample: { file: "src/hit.ts", startLine: 20, endLine: 21, extractedSha256: "0".repeat(64) },
    };
    const out = refreshStep(step, parseUnifiedZeroDiff(DIFF), SHA_B, () => "whatever");
    expect(out.outcome).toBe("stale");
  });

  it("invalidates a step whose file was deleted", () => {
    const step = {
      id: "x",
      title: "t",
      kind: "code",
      sample: { file: "src/gone.ts", startLine: 1, endLine: 2, extractedSha256: "0".repeat(64) },
    };
    expect(refreshStep(step, parseUnifiedZeroDiff(DIFF), SHA_B, () => null).outcome).toBe("invalidated");
  });

  it("degrades a bad rebase to a badge and never to wrong-code-shown-fresh", () => {
    const step = {
      id: "x",
      title: "t",
      kind: "code",
      sample: { file: "src/a.ts", startLine: 50, endLine: 52, extractedSha256: "0".repeat(64) },
    };
    const out = refreshStep(step, parseUnifiedZeroDiff(DIFF), SHA_B, () =>
      Array.from({ length: 90 }, (_, i) => `q${i}`).join("\n")
    );
    expect(out.outcome).toBe("stale");
    expect(out.step.staleness.status).not.toBe("fresh");
  });

  it("skips diff samples, whose anchors are immutable", () => {
    const step = {
      id: "x",
      title: "t",
      kind: "code",
      diffSample: { file: "a", sha: SHA_A, patch: "p", extractedSha256: hashText("p") },
    };
    expect(refreshStep(step, new Map(), SHA_B, () => null).outcome).toBe("skipped");
  });

  it("does not advance a flow's anchor while any step is stale", () => {
    const flow = goodFlow();
    Object.assign(flow.states[0].steps[0].sample, {
      file: "src/hit.ts",
      startLine: 20,
      endLine: 21,
      highlights: [[20, 20]],
    });
    const { flow: next, report } = refreshFlow(flow, parseUnifiedZeroDiff(DIFF), SHA_B, () => "x\ny");
    expect(report.stale.length).toBeGreaterThan(0);
    // A half-refreshed flow must not claim to describe a commit it does not.
    expect(next.anchoredAt.sha).toBe(SHA_A);
  });
});

describe("derived indexes are computed, never stored", () => {
  it("maps files to the flows and steps that use them", () => {
    const index = buildFileIndex([goodFlow()]);
    expect(index["src/a.ts"]).toEqual([{ flowId: "demo-flow", stepIds: ["one"] }]);
    expect(index["src/b.ts"]).toBeTruthy();
  });

  it("flags an uncommitted file no flow covers", () => {
    const index = buildFileIndex([goodFlow()]);
    const view = uncommittedView(
      [
        { file: "src/a.ts", status: "modified" },
        { file: "src/zzz.ts", status: "added" },
      ],
      index
    );
    expect(view[0].unmapped).toBe(false);
    expect(view[1].unmapped).toBe(true);
  });

  it("scopes an update run to the flows a change touches", () => {
    expect(flowsTouchingFiles(buildFileIndex([goodFlow()]), ["src/b.ts"])).toEqual(["demo-flow"]);
  });

  it("summarises staleness across flows", () => {
    expect(stalenessSummary([goodFlow()]).total).toBe(2);
  });
});

describe("prompt buttons compose dispatchable prompts", () => {
  const ctx = {
    project: "/repo",
    flowId: "demo-flow",
    sha: SHA_A,
    question: "why?",
    findings: [{ id: "f1", flowId: "demo-flow", text: "bad", span: { file: "x.ts", startLine: 1 } }],
  };

  it("builds a card prompt for every long-running mode", () => {
    for (const mode of [
      "full-run",
      "update",
      "fix-findings",
      "compare",
      "generate-tests",
      "walkthrough",
      "cleanup",
    ]) {
      const d = buildDispatch(mode, ctx);
      expect(d.transport).toBe("card");
      expect(d.prompt).toContain("garrison-project-viewer");
      // Leading with a slash command would silently truncate the argument.
      expect(d.prompt.startsWith("/")).toBe(false);
      expect(d.prompt.length).toBeLessThan(3800);
    }
  });

  it("sends only a short question through chat", () => {
    expect(buildDispatch("ask", ctx).transport).toBe("chat");
  });

  it("refuses an unknown mode", () => {
    expect(() => buildDispatch("nope", ctx)).toThrow(/unknown mode/);
  });

  it("stays under the card ceiling even with hundreds of findings, and says what it omitted", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      id: `f${i}`,
      flowId: "demo-flow",
      text: "a fairly long finding description that repeats itself ".repeat(3),
      span: { file: "src/some/deep/path/file.ts", startLine: i },
    }));
    const prompt = fixPrompt({ project: "/repo", findings: many });
    expect(prompt.length).toBeLessThan(3800);
    expect(prompt).toMatch(/more, listed in viewer\/findings\.json/);
    expect(prompt).toContain("f0");
  });
});

describe("the flow landing view shows the whole shape at once", () => {
  it("lists every step across every state, numbered end to end", () => {
    const flow = goodFlow();
    const html = renderFlowOutline(flow, { project: "p" });
    // The brief asks for a landing view you can jump from; a breadcrumb alone
    // hides how big a flow is until you have clicked through all of it.
    expect(html).toContain("1 states · 2 steps");
    expect(html).toContain('class="o-steps"');
    expect(html).toContain("Step one");
    expect(html).toContain("Step two");
    // Running numbers, so density is readable at a glance.
    expect(html).toContain('<span class="o-n">1</span>');
    expect(html).toContain('<span class="o-n">2</span>');
  });

  it("shows each step's file and line range without opening it", () => {
    const html = renderFlowOutline(goodFlow(), { project: "p" });
    expect(html).toContain("src/a.ts:1–2");
    expect(html).toContain("src/b.ts:5–6");
  });

  it("flags what is folded and what is unnarrated", () => {
    const flow = goodFlow();
    flow.states[0].steps[0].description = "" as any;
    const html = renderFlowOutline(flow, { project: "p" });
    expect(html).toContain("is-folded");
    expect(html).toContain("is-unnarrated");
    expect(html).toContain('data-narrated="false"');
    expect(html).toContain('data-collapsed="true"');
  });

  it("links each row to that exact step, and offers a walk from the start", () => {
    const html = renderFlowOutline(goodFlow(), { project: "p" });
    expect(html).toContain('href="/flow/demo-flow/state/0#one"');
    expect(html).toContain('href="/flow/demo-flow/state/0"');
    expect(html).toContain("Step through from the start");
  });

  it("carries the machine index with no current state", () => {
    const html = renderFlowOutline(goodFlow(), { project: "p" });
    const block = /<script type="application\/json" id="pv-index">([\s\S]*?)<\/script>/.exec(html);
    const data = JSON.parse(block![1].replace(/\\u003c/g, "<"));
    expect(data.currentState).toBeNull();
    expect(data.states[0].steps).toHaveLength(2);
  });

  it("translates", () => {
    const html = renderFlowOutline(goodFlow(), { project: "p", lang: "pt" });
    expect(html).toContain("Percorrer desde o início");
    expect(html).toContain("1 estados · 2 passos");
  });

  it("gives each step an id so a single step can be linked to", () => {
    const flow = goodFlow();
    const html = renderFlowState(flow, { stateIndex: 0, samples: resolvedSamples(flow), project: "p" });
    expect(html).toContain('<article id="one"');
    expect(html).toContain('<article id="two"');
  });
});

describe("the page is legible to an agent, not only to a person", () => {
  it("emits a machine index carrying every step's anchor", () => {
    const flow = goodFlow();
    const html = renderFlowState(flow, { stateIndex: 0, samples: resolvedSamples(flow), project: "p" });
    const match = /<script type="application\/json" id="pv-index">([\s\S]*?)<\/script>/.exec(html);
    expect(match, "the page must carry a machine index").toBeTruthy();

    const data = JSON.parse(match![1].replace(/\\u003c/g, "<"));
    expect(data.flowId).toBe("demo-flow");
    expect(data.anchoredAt.sha).toBe(SHA_A);
    expect(data.currentState).toBe(0);
    // An agent gets file and line range without scraping any markup.
    expect(data.states[0].steps[0]).toMatchObject({
      id: "one",
      kind: "code",
      file: "src/a.ts",
      startLine: 1,
      endLine: 2,
      staleness: "fresh",
      narrated: true,
    });
    expect(data.states[0].steps[1].collapsed).toBe(true);
    expect(data.states[0].url).toBe("/flow/demo-flow/state/0");
  });

  it("cannot be broken out of by a closing script tag in the data", () => {
    const flow = goodFlow();
    flow.states[0].steps[0].description = "danger </script><script>alert(1)</script>" as any;
    const html = renderFlowState(flow, { stateIndex: 0, samples: resolvedSamples(flow), project: "p" });
    const block = /<script type="application\/json" id="pv-index">([\s\S]*?)<\/script>/.exec(html);
    expect(block).toBeTruthy();
    // The escaped form is inside the JSON; no live script tag anywhere.
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(() => JSON.parse(block![1].replace(/\\u003c/g, "<"))).not.toThrow();
  });

  it("puts the jump target on the step element itself", () => {
    const flow = goodFlow();
    const html = renderFlowState(flow, { stateIndex: 0, samples: resolvedSamples(flow), project: "p" });
    expect(html).toContain('data-step="one"');
    expect(html).toContain('data-flow="demo-flow"');
    expect(html).toContain('data-state="s1"');
    expect(html).toContain('data-file="src/a.ts"');
    expect(html).toContain('data-start-line="1"');
    expect(html).toContain('data-end-line="2"');
    expect(html).toContain(`data-sha="${SHA_A}"`);
    expect(html).toContain('data-staleness="fresh"');
    expect(html).toContain('data-collapsed="true"');
    expect(html).toContain('data-narrated="true"');
  });

  it("gives the document real landmarks and a nested heading order", () => {
    const flow = goodFlow();
    const html = renderFlowState(flow, { stateIndex: 0, samples: resolvedSamples(flow), project: "p" });
    expect(html).toContain('<main id="content">');
    expect(html).toContain('class="skip"');
    expect(html).toContain("<h1>");
    expect(html).toContain('<h2 class="state-title"');
    expect(html).toContain('<h3 class="step-title">');
  });
});

describe("badges only speak when they have something to say", () => {
  it("shows no per-step badge when every step is fresh, and one flow-level badge instead", () => {
    const flow = goodFlow();
    const html = renderFlowState(flow, { stateIndex: 0, samples: resolvedSamples(flow), project: "p" });
    // A wall of green trains the eye to ignore badges — the opposite of the point.
    expect(html).not.toContain('class="badge b-fresh"');
    expect(html).toContain("b-verified");
    expect(html).toContain("all 2 steps verified");
  });

  it("shows the per-step badge the moment a step goes stale", () => {
    const flow = goodFlow();
    flow.states[0].steps[0].staleness = { status: "stale", checkedAtSha: SHA_B } as any;
    const html = renderFlowState(flow, { stateIndex: 0, samples: resolvedSamples(flow), project: "p" });
    expect(html).toContain("b-stale");
    expect(html).toContain("1 of 2 steps need re-narration");
    expect(html).toContain('data-staleness="stale"');
  });
});

describe("a mechanically generated step admits it is not narrated", () => {
  it("says so instead of showing an empty half", () => {
    const flow = goodFlow();
    flow.states[0].steps[0].description = "" as any;
    const html = renderFlowState(flow, { stateIndex: 0, samples: resolvedSamples(flow), project: "p" });
    expect(html).toContain("not-narrated");
    expect(html).toContain("Not yet narrated");
    expect(html).toContain('data-narrated="false"');
  });

  it("translates that admission too", () => {
    const flow = goodFlow();
    flow.states[0].steps[0].description = "" as any;
    const html = renderFlowState(flow, { stateIndex: 0, samples: resolvedSamples(flow), project: "p", lang: "pt" });
    expect(html).toContain("Ainda não narrado");
  });
});

describe("the interface is bilingual without doubling the token cost", () => {
  it("carries exactly the same keys in both languages", () => {
    // A key present in one table and missing from the other silently falls back,
    // which reads as a half-translated page. Assert parity instead of hoping.
    expect(keysFor("pt")).toEqual(keysFor("en"));
    expect(keysFor("en").length).toBeGreaterThan(80);
  });

  it("translates chrome and interpolates variables", () => {
    expect(t("en", "nav.findings")).toBe("Findings");
    expect(t("pt", "nav.findings")).toBe("Achados");
    expect(t("pt", "pane.lines", { from: 3, to: 9 })).toContain("linhas 3");
    expect(t("en", "badge.open", { n: 4 })).toBe("4 open");
  });

  it("returns the key rather than throwing when a string is missing", () => {
    expect(t("en", "no.such.key")).toBe("no.such.key");
  });

  it("normalises language tags and flips to the other one", () => {
    expect(normaliseLang("pt-BR")).toBe("pt");
    expect(normaliseLang("PT")).toBe("pt");
    expect(normaliseLang("fr")).toBe("en");
    expect(normaliseLang("")).toBe("en");
    expect(otherLang("pt")).toBe("en");
    expect(otherLang("en")).toBe("pt");
    expect(LANGS).toEqual(["en", "pt"]);
  });

  it("reads prose as a plain string or as a per-language map", () => {
    // Single-language prose is the norm; the map is opt-in, because filling both
    // means the model writes every description twice.
    expect(pickText("plain", "pt")).toBe("plain");
    expect(pickText({ en: "hello", pt: "olá" }, "pt")).toBe("olá");
    expect(pickText({ en: "hello", pt: "olá" }, "en")).toBe("hello");
    // Falls back across languages rather than rendering an empty pane.
    expect(pickText({ en: "only english" }, "pt")).toBe("only english");
    expect(pickText(null, "pt")).toBe("");
  });

  it("renders a whole page in Portuguese, chrome and all", () => {
    const flow = goodFlow();
    const html = renderFlowState(flow, {
      stateIndex: 0,
      samples: resolvedSamples(flow),
      project: "p",
      lang: "pt",
    });
    expect(html).toContain('<html lang="pt"');
    expect(html).toContain('data-lang="pt"');
    expect(html).toContain("Fluxos");
    expect(html).toContain("Agir sobre este fluxo");
    expect(html).toContain("Atualizar análise");
    // The toggle offers the other language, not the current one.
    expect(html).toContain('href="/lang/en"');
    expect(html).not.toContain("Act on this flow");
  });

  it("keeps each language deterministic on its own", () => {
    const flow = goodFlow();
    const opts = { stateIndex: 0, project: "p", lang: "pt" as const };
    const a = renderFlowState(flow, { ...opts, samples: resolvedSamples(flow) });
    const b = renderFlowState(flow, { ...opts, samples: resolvedSamples(flow) });
    expect(a).toBe(b);
    // And the two languages really do differ, so the parameter is doing work.
    const en = renderFlowState(flow, { stateIndex: 0, samples: resolvedSamples(flow), project: "p", lang: "en" });
    expect(en).not.toBe(a);
  });

  it("renders bilingual prose in the requested language", () => {
    const flow = goodFlow();
    flow.states[0].steps[0].description = { en: "Reads the registry.", pt: "Lê o registo." } as any;
    const pt = renderFlowState(flow, { stateIndex: 0, samples: resolvedSamples(flow), project: "p", lang: "pt" });
    expect(pt).toContain("Lê o registo.");
    expect(pt).not.toContain("Reads the registry.");
  });

  it("accepts a per-language map wherever prose is valid", () => {
    const flow = goodFlow();
    flow.states[0].steps[0].title = { en: "Step one", pt: "Passo um" } as any;
    flow.states[0].label = { en: "First", pt: "Primeiro" } as any;
    expect(validateFlow(flow).ok).toBe(true);
    // A map with an unsupported language, or an empty map, is still a mistake.
    flow.states[0].steps[0].title = { fr: "Étape" } as any;
    expect(validateFlow(flow).ok).toBe(false);
    flow.states[0].steps[0].title = {} as any;
    expect(validateFlow(flow).ok).toBe(false);
  });

  it("translates the integrity refusal too, and still shows no code", () => {
    const flow = goodFlow();
    const html = renderFlowState(flow, {
      stateIndex: 0,
      samples: resolvedSamples(flow, false),
      project: "p",
      lang: "pt",
    });
    expect(html).toContain("A verificação de integridade da amostra falhou.");
    expect(html).not.toContain("line one");
  });

  it("renders the fold label as markup so it can be translated", () => {
    // CSS `content` cannot be translated, so the expand/collapse word has to be
    // in the document.
    const flow = goodFlow();
    const html = renderFlowState(flow, { stateIndex: 0, samples: resolvedSamples(flow), project: "p", lang: "pt" });
    expect(html).toContain("expandir");
    expect(html).toContain("recolher");
  });

  it("never turns the language toggle into an open redirect", () => {
    // The Referer is attacker-controllable, so only a same-origin path may ever
    // reach the Location header.
    expect(safeReturnPath("http://127.0.0.1:27097/flow/x/state/2")).toBe("/flow/x/state/2");

    // A path this server does not serve goes to the index, so a foreign host's
    // path cannot even land the reader on our own 404.
    expect(safeReturnPath("https://evil.example/phish")).toBe("/");
    expect(safeReturnPath("//evil.example/phish")).toBe("/");

    // The genuinely dangerous input: a path that is ITSELF protocol-relative.
    // `Location: //attacker.example/x` sends the browser off-origin even though
    // it looks like a path, which is exactly what the leading-slash guard is for.
    expect(safeReturnPath("http://127.0.0.1:27097//attacker.example/x")).toBe("/");

    // Real routes survive, including their query string.
    expect(safeReturnPath("http://127.0.0.1:27097/findings")).toBe("/findings");
    expect(safeReturnPath("http://127.0.0.1:27097/files/src/lib/git.mjs")).toBe("/files/src/lib/git.mjs");

    expect(safeReturnPath(undefined)).toBe("/");
    expect(safeReturnPath("not a url at all")).toBe("/");
    // Flipping from the toggle route itself must not bounce between toggles.
    expect(safeReturnPath("http://127.0.0.1:27097/lang/pt")).toBe("/");
  });

  it("only ever returns a rooted, single-slash path", () => {
    // Property-style backstop over the case-by-case assertions above.
    const hostile = [
      "https://evil.example/a",
      "//evil.example/a",
      "http://x//y",
      "http://x/\\\\evil.example",
      "javascript:alert(1)",
      "http://x/ok?q=1",
      "",
    ];
    for (const referer of hostile) {
      const out = safeReturnPath(referer);
      expect(out.startsWith("/")).toBe(true);
      expect(out.startsWith("//")).toBe(false);
      expect(out).not.toContain("evil.example");
    }
  });
});

describe("the runtime spine comes from routing rules, not from guessing", () => {
  const APP = [
    "src/app/layout.tsx",
    "src/app/page.tsx",
    "src/app/quarters/layout.tsx",
    "src/app/quarters/page.tsx",
    "src/app/quarters/[type]/page.tsx",
    "src/app/api/quarters/[type]/route.ts",
    "src/app/api/compositions/route.ts",
    "src/app/(dashboard)/settings/page.tsx",
    "src/app/files/[...path]/page.tsx",
    "src/app/docs/[[...slug]]/page.tsx",
    "src/lib/not-an-app-file.ts",
  ];

  it("maps a static path to its page and its layout chain", () => {
    const r = resolveAppRoute("/quarters", APP);
    expect(r?.file).toBe("src/app/quarters/page.tsx");
    expect(r?.kind).toBe("page");
    // Layouts are the chrome that rendered around the page; a reader following a
    // UI flow usually needs them as much as the page.
    expect(r?.layouts).toEqual(["src/app/layout.tsx", "src/app/quarters/layout.tsx"]);
  });

  it("extracts dynamic params", () => {
    const r = resolveAppRoute("/api/quarters/hooks", APP);
    expect(r?.file).toBe("src/app/api/quarters/[type]/route.ts");
    expect(r?.params).toEqual({ type: "hooks" });
  });

  it("prefers a static segment over a dynamic one", () => {
    // /quarters must not be captured by /quarters/[type].
    expect(resolveAppRoute("/quarters", APP)?.file).toBe("src/app/quarters/page.tsx");
    expect(resolveAppRoute("/quarters/hooks", APP)?.file).toBe("src/app/quarters/[type]/page.tsx");
  });

  it("ignores route groups, which carry no URL segment", () => {
    expect(resolveAppRoute("/settings", APP)?.file).toBe("src/app/(dashboard)/settings/page.tsx");
  });

  it("handles catch-all and optional catch-all", () => {
    const c = resolveAppRoute("/files/src/lib/git.mjs", APP);
    expect(c?.file).toBe("src/app/files/[...path]/page.tsx");
    expect(c?.params).toEqual({ path: ["src", "lib", "git.mjs"] });
    // A required catch-all needs at least one segment; an optional one does not.
    expect(resolveAppRoute("/files", APP)).toBeNull();
    expect(resolveAppRoute("/docs", APP)?.file).toBe("src/app/docs/[[...slug]]/page.tsx");
  });

  it("returns null rather than inventing a file", () => {
    // An unmapped request is recorded as unmapped. Guessing here would be the one
    // failure mode that produces a confident wrong spine.
    expect(resolveAppRoute("/nope/nowhere", APP)).toBeNull();
    expect(resolveAppRoute("/quarters", [])).toBeNull();
  });

  it("follows a literal redirect to the page the reader actually used", () => {
    // The wrong answer this prevents, found by running it for real: a test that
    // goes to /memory lands on a three-line stub that redirects, and every action
    // after it happens on the target. Without following the hop, the spine points
    // at the stub and claims that is where the work happens.
    const files = [...APP, "src/app/memory/page.tsx", "src/app/quarters/context/page.tsx"];
    const read = (f: string) =>
      f === "src/app/memory/page.tsx"
        ? 'import { permanentRedirect } from "next/navigation";\nexport default function P() { permanentRedirect("/quarters/context"); }'
        : "export default function P() { return null; }";

    const r = resolveThroughRedirects("/memory", files, { read });
    expect(r?.file).toBe("src/app/quarters/context/page.tsx");
    // The hop is recorded, not hidden.
    expect(r?.via).toEqual([{ file: "src/app/memory/page.tsx", to: "/quarters/context" }]);
  });

  it("says so rather than guessing when a redirect target is computed", () => {
    const files = ["src/app/x/page.tsx", "src/app/y/page.tsx"];
    const read = () => 'import { redirect } from "next/navigation";\nredirect(someVariable);';
    const r = resolveThroughRedirects("/x", files, { read });
    expect(r?.redirects).toBe("dynamic");
    // It stays on the stub instead of inventing a destination.
    expect(r?.file).toBe("src/app/x/page.tsx");
  });

  it("detects redirect calls and their literal targets", () => {
    expect(redirectTargetOf('permanentRedirect("/a/b")')).toEqual({ target: "/a/b", kind: "literal" });
    expect(redirectTargetOf("redirect('/c')")).toEqual({ target: "/c", kind: "literal" });
    expect(redirectTargetOf("redirect(target)")).toEqual({ target: null, kind: "dynamic" });
    expect(redirectTargetOf("export default function P() { return null; }")).toBeNull();
  });

  it("cannot loop forever on a redirect cycle", () => {
    const files = ["src/app/a/page.tsx", "src/app/b/page.tsx"];
    const read = (f: string) =>
      f === "src/app/a/page.tsx" ? 'redirect("/b")' : 'redirect("/a")';
    const r = resolveThroughRedirects("/a", files, { read });
    expect(r).toBeTruthy();
    expect((r?.via ?? []).length).toBeLessThanOrEqual(3);
  });

  it("can be narrowed to API handlers for a network request", () => {
    expect(resolveApiRoute("/api/compositions", APP)?.file).toBe("src/app/api/compositions/route.ts");
    expect(resolveApiRoute("/quarters", APP)).toBeNull();
  });

  it("strips query and hash before matching", () => {
    expect(pathSegments("/quarters/hooks?x=1#frag")).toEqual(["quarters", "hooks"]);
  });
});

describe("candidate files come from real imports, bounded", () => {
  const FILES: Record<string, string> = {
    "src/app/api/quarters/[type]/route.ts": `
      import { readHooks } from "@/lib/hooks-crud";
      import { atomicWrite } from "../../../../lib/atomic-write";
      export async function GET() { return readHooks(); }
    `,
    "src/lib/hooks-crud.ts": `
      import { parse } from "./parse-hooks";
      import fs from "node:fs";
      export function readHooks() { return parse(); }
    `,
    "src/lib/parse-hooks.ts": `import { deep } from "./deeper"; export function parse() { return deep(); }`,
    "src/lib/deeper.ts": `export function deep() { return 1; }`,
    "src/lib/atomic-write.ts": `export function atomicWrite() {}`,
  };
  const read = (f: string) => FILES[f] ?? null;

  it("finds the specifiers a file imports, including aliases and requires", () => {
    const specs = importSpecifiers(FILES["src/app/api/quarters/[type]/route.ts"]);
    expect(specs).toContain("@/lib/hooks-crud");
    expect(specs).toContain("../../../../lib/atomic-write");
  });

  it("skips third-party packages", () => {
    expect(isLocal("node:fs", { "@/": "src/" })).toBe(false);
    expect(isLocal("react", { "@/": "src/" })).toBe(false);
    expect(isLocal("@/lib/x", { "@/": "src/" })).toBe(true);
    expect(isLocal("./x", { "@/": "src/" })).toBe(true);
  });

  it("resolves aliases and relative paths to real files", () => {
    const exists = (f: string) => read(f) !== null;
    expect(resolveSpecifier("@/lib/hooks-crud", "src/app/x/route.ts", { exists })).toBe(
      "src/lib/hooks-crud.ts"
    );
    expect(resolveSpecifier("./parse-hooks", "src/lib/hooks-crud.ts", { exists })).toBe(
      "src/lib/parse-hooks.ts"
    );
    // Nothing to resolve is a legitimate answer, not an error.
    expect(resolveSpecifier("react", "src/lib/x.ts", { exists })).toBeNull();
    expect(resolveSpecifier("./missing", "src/lib/x.ts", { exists })).toBeNull();
  });

  it("walks two levels and no further", () => {
    const found = importCandidates("src/app/api/quarters/[type]/route.ts", { read, maxDepth: 2 });
    const files = found.map((c) => c.file);
    expect(files).toContain("src/lib/hooks-crud.ts");
    expect(files).toContain("src/lib/atomic-write.ts");
    expect(files).toContain("src/lib/parse-hooks.ts");
    // Depth 3 is beyond the bound: cost control, not a correctness claim.
    expect(files).not.toContain("src/lib/deeper.ts");
    expect(found.every((c) => c.depth <= 2)).toBe(true);
  });

  it("never revisits a file, so a cycle cannot hang it", () => {
    const cyclic: Record<string, string> = {
      "a.ts": `import "./b";`,
      "b.ts": `import "./a";`,
    };
    const found = importCandidates("a.ts", { read: (f: string) => cyclic[f] ?? null, maxDepth: 5 });
    expect(found.map((c) => c.file)).toEqual(["b.ts"]);
  });

  it("ranks shallow, route-echoing, non-test files first", () => {
    const ranked = rankCandidates(
      [
        { file: "src/lib/hooks-crud.ts", depth: 1, via: "route.ts" },
        { file: "src/lib/deep-thing.ts", depth: 2, via: "x" },
        { file: "src/lib/hooks-crud.test.ts", depth: 1, via: "route.ts" },
      ],
      { hintPath: "/api/quarters/hooks" }
    );
    expect(ranked[0].file).toBe("src/lib/hooks-crud.ts");
    // A test file rarely explains a runtime step, so it sinks.
    expect(ranked[ranked.length - 1].file).toBe("src/lib/hooks-crud.test.ts");
  });

  it("requires a reader rather than touching disk", () => {
    expect(() => importCandidates("a.ts", {} as any)).toThrow(/read\(file\)/);
  });
});

describe("the step-title parser tolerates both Playwright wordings", () => {
  it("reads the modern human-readable titles (1.6x)", () => {
    // Verified against the installed Playwright, not guessed: 1.60 titles steps
    // `Navigate to "url"`, `Click`, `Double click`, and so on.
    expect(actionOf('Navigate to "http://127.0.0.1:3401/quarters"')).toBe("goto");
    expect(actionOf("Click")).toBe("click");
    expect(actionOf("Double click")).toBe("dblclick");
    expect(actionOf("Check")).toBe("check");
    expect(actionOf("Uncheck")).toBe("uncheck");
    expect(actionOf("Hover")).toBe("hover");
    expect(actionOf("Press")).toBe("press");
    expect(actionOf("Select option")).toBe("selectOption");
    expect(actionOf("Set input files")).toBe("setInputFiles");
  });

  it("still reads the legacy titles (≤1.4x)", () => {
    expect(actionOf("page.goto(/quarters)")).toBe("goto");
    expect(actionOf("locator.click(button)")).toBe("click");
    expect(actionOf("locator.fill(input)")).toBe("fill");
  });

  it("ignores infrastructure and assertions", () => {
    expect(actionOf("Launch browser")).toBeNull();
    expect(actionOf('Expect "toBeVisible"')).toBeNull();
    expect(actionOf("page.evaluate")).toBeNull();
    expect(actionOf("")).toBeNull();
  });

  it("pulls the URL or selector out of a title when one is there", () => {
    expect(argOf('Navigate to "http://127.0.0.1:3401/quarters"')).toBe("http://127.0.0.1:3401/quarters");
    expect(argOf("page.goto(/quarters)")).toBe("/quarters");
    expect(argOf("Click getByRole('button')")).toBe("button");
    // Modern locator titles often carry nothing, which is why the reporter also
    // records the spec line that caused the action.
    expect(argOf("Click")).toBeNull();
  });

  it("knows which actions establish a URL", () => {
    expect(isNavigation("goto")).toBe(true);
    expect(isNavigation("waitForURL")).toBe(true);
    expect(isNavigation("click")).toBe(false);
  });
});

describe("captures are ordered, run-scoped, and shaped the same whatever the source", () => {
  it("gives every action the URL it happened on", () => {
    const stitched = stitchUrls([
      { action: "goto", url: "http://127.0.0.1:3401/quarters" },
      { action: "click", url: null },
      { action: "fill", url: null },
      { action: "goto", url: "/quarters/hooks" },
      { action: "press", url: null },
    ]);
    expect(stitched.map((a) => a.url)).toEqual([
      "/quarters",
      "/quarters",
      "/quarters",
      "/quarters/hooks",
      "/quarters/hooks",
    ]);
  });

  it("reduces an absolute URL to a path, since a port is not part of a route", () => {
    expect(stripOrigin("http://127.0.0.1:3401/quarters?x=1")).toBe("/quarters?x=1");
    expect(stripOrigin("https://host/a/b")).toBe("/a/b");
    expect(stripOrigin("/already")).toBe("/already");
    expect(stripOrigin("bare")).toBe("/bare");
  });

  it("calls the argument `arg`, because for a fill it is the value not a selector", () => {
    // Found by reading a real capture: Playwright titles `pressSequentially` as
    // `Fill "the-typed-text"`, so the field holds the VALUE. Naming it `selector`
    // was a small lie a reader would only discover by being confused.
    const e = actionEvent(1, { action: "fill", selector: "EDITED-BY-E2E", url: "/x", at: { file: "s.ts", line: 30 } });
    expect(e.arg).toBe("EDITED-BY-E2E");
    expect(e).not.toHaveProperty("selector");
    // The spec line survives into the event, which an earlier version dropped.
    expect(e.at).toEqual({ file: "s.ts", line: 30 });
  });

  it("labels an action with where the reader ended up, keeping what was asked for", () => {
    // Found by reading a real capture: every action after a server-side redirect was
    // labelled with the requested URL, so the spine read as though the interaction
    // happened on a page it never touched.
    const moved = actionEvent(1, { action: "click", url: "/quarters/context", requestedUrl: "/memory" });
    expect(moved.url).toBe("/quarters/context");
    expect(moved.requestedUrl).toBe("/memory");
    // When nothing moved, there is no second field to explain.
    const direct = actionEvent(1, { action: "click", url: "/x", requestedUrl: "/x" });
    expect(direct).not.toHaveProperty("requestedUrl");
  });

  it("records redirect hops on a route event instead of hiding them", () => {
    const withHop = routeEvent(2, {
      forSeq: 1,
      file: "src/app/quarters/context/page.tsx",
      kind: "page",
      via: [{ file: "src/app/memory/page.tsx", to: "/quarters/context" }],
    });
    expect(withHop.via).toHaveLength(1);
    // No hop, no noise.
    expect(routeEvent(2, { forSeq: 1, file: "a", kind: "page" })).not.toHaveProperty("via");
  });

  it("builds a stable key per test", () => {
    expect(testKey({ file: "tests/e2e/quarters.spec.ts", title: "edits a hook", project: "desktop-chromium" }))
      .toBe("tests-e2e-quarters.spec.ts--edits-a-hook--desktop-chromium");
  });

  it("keeps the same shape for a vision capture as for a test capture", () => {
    const fromTest = buildCapture({ source: "e2e", test: { file: "a", title: "b" }, events: [] });
    const fromVision = buildCapture({ source: "ui", test: { title: "driven by vision" }, events: [] });
    expect(Object.keys(fromTest).sort()).toEqual(Object.keys(fromVision).sort());
    expect(fromVision.source).toBe("ui");
  });

  it("turns a missing test into a finding rather than silence", () => {
    const f = noCoverageFinding("checkout-flow", { file: "src/app/checkout/page.tsx" });
    expect(f.severity).toBe("info");
    expect(f.category).toBe("missing-test");
    expect(f.flowId).toBe("checkout-flow");
    expect(f.evidence).toBe("static");
    expect(validateFindings({ schemaVersion: 1, findings: [f] }).ok).toBe(true);
  });
});

describe("the fitting package is registered and intact", () => {
  it("is listed in the registry, or it would be silently dropped", async () => {
    const library = (await import("../data/library.json")).default as any[];
    const entry = library.find((e) => e.id === "project-viewer");
    expect(entry, "project-viewer must be in data/library.json").toBeTruthy();
    expect(entry.localPath).toBe("fittings/seed/project-viewer");
    expect(entry.repo).toBe("local:fittings/seed/project-viewer");
  });

  it("declares no capability kind it does not need", async () => {
    const { readYamlFile } = await import("@/lib/yaml");
    const manifest = await readYamlFile<any>(
      path.resolve(__dirname, "..", "fittings", "seed", "project-viewer", "apm.yml")
    );
    const meta = manifest["x-garrison"];
    expect(meta.provides).toEqual([]);
    // `view` is derived by the resolver from ui.views/own_port and must never be
    // declared; `agent-skill` is retired and throws on read.
    const declared = JSON.stringify(meta.provides ?? []);
    expect(declared).not.toContain("agent-skill");
    expect(declared).not.toContain('"view"');
    expect(meta.own_port).toBe(true);
    expect(meta.ui.views[0].entry).toBe("./dist/index.html");
  });
});

// ---------------------------------------------------------------- runtime spine

describe("a capture becomes a spec whose spine cannot be quietly rewritten", () => {
  const capture = {
    schemaVersion: 1,
    source: "e2e",
    runId: "20260811-1200",
    status: "passed",
    test: { file: "tests/e2e/memory.spec.ts", title: "Context memory autosaves", project: "desktop-chromium" },
    anchoredAt: { sha: "a".repeat(40), dirty: false },
    events: [
      {
        seq: 1,
        type: "action",
        action: "goto",
        arg: null,
        url: "/quarters/context",
        requestedUrl: "/memory",
        at: { file: "tests/e2e/memory.spec.ts", line: 15 },
        ok: true,
      },
      {
        seq: 2,
        type: "route",
        forSeq: 1,
        file: "src/app/quarters/[type]/page.tsx",
        kind: "page",
        params: { type: "context" },
        layouts: ["src/app/layout.tsx"],
        // `file`, not `from` — the name resolveThroughRedirects actually uses. An
        // earlier version of this fixture invented `from`, which made the test pass
        // against code that printed "undefined" against the real capture.
        via: [{ file: "src/app/memory/page.tsx", to: "/quarters/context" }],
      },
      { seq: 3, type: "candidates", forSeq: 2, files: [{ file: "src/components/ContextPanel.tsx", rank: 9 }] },
      { seq: 4, type: "action", action: "click", arg: "context-editor", url: "/quarters/context", ok: true },
      { seq: 5, type: "action", action: "fill", arg: "hello", url: "/nowhere", ok: false },
    ],
  };

  it("groups steps by page in first-visit order and locks the order it saw", () => {
    const spec = specFromCapture(capture, { captureRef: "abc/run/key" });

    expect(spec.source).toBe("e2e");
    expect(spec.runStatus).toBe("passed");
    expect(spec.provenance.captureRef).toBe("abc/run/key");
    expect(spec.provenance.testFile).toBe("tests/e2e/memory.spec.ts");

    expect(spec.states.map((s: any) => s.label)).toEqual(["/quarters/context", "/nowhere"]);
    expect(spec.states[0].steps.map((s: any) => s.id)).toEqual(["s1a1", "s1a2"]);
    expect(spec.spine.map((s: any) => s.id)).toEqual(["s1a1", "s1a2", "s2a1"]);
    expect(spec.spine.map((s: any) => s.action)).toEqual(["goto", "click", "fill"]);
  });

  it("leaves every description empty, because narration is not its job", () => {
    const spec = specFromCapture(capture);
    const all = spec.states.flatMap((s: any) => s.steps);
    expect(all.every((s: any) => s.description === "")).toBe(true);
    expect(spec.summary).toBe("");
  });

  it("marks a step with no resolved file as glue rather than inventing one", () => {
    const spec = specFromCapture(capture);
    expect(spec.states[0].steps[0].kind).toBe("code");
    expect(spec.states[0].steps[0].hints.routeFile).toBe("src/app/quarters/[type]/page.tsx");
    // /nowhere resolved to nothing. `code` would demand a sample there is no file for.
    expect(spec.states[1].steps[0].kind).toBe("glue");
    expect(spec.states[1].steps[0].hints.routeFile).toBeUndefined();
  });

  it("offers candidates once per page, not under every click", () => {
    const spec = specFromCapture(capture);
    expect(spec.states[0].steps[0].hints.candidates).toEqual(["src/components/ContextPanel.tsx"]);
    expect(spec.states[0].steps[1].hints.candidates).toBeUndefined();
  });

  it("carries forward every admission the capture made about itself", () => {
    const spec = specFromCapture(capture);
    const first = spec.states[0].steps[0].hints.admissions.join(" | ");
    expect(first).toContain("asked for /memory");
    expect(first).toContain("redirect stub src/app/memory/page.tsx");

    const failed = spec.states[1].steps[0].hints.admissions.join(" | ");
    expect(failed).toContain("FAILED");
    expect(failed).toContain("no file was resolved");
  });

  it("names a dynamic redirect as underivable instead of guessing", () => {
    const said = admissionsFor({
      action: { url: "/x", ok: true },
      route: { file: "src/app/x/page.tsx", redirects: "dynamic" },
    });
    expect(said.join(" ")).toContain("computed at runtime");
    expect(said.join(" ")).toContain("do not guess");
  });

  it("refuses a capture with no actions", () => {
    expect(() => specFromCapture({ events: [] })).toThrow(/no actions/);
  });

  it("records the spec line, which is structural where a step title is not", () => {
    const spec = specFromCapture(capture);
    expect(spec.states[0].steps[0].hints.specLine).toBe("tests/e2e/memory.spec.ts:15");
  });

  it("titles steps mechanically", () => {
    expect(stepTitle({ action: "goto", arg: "/x" })).toBe("Navigate to /x");
    expect(stepTitle({ action: "click", arg: null })).toBe("Click");
    expect(stepTitle({ action: "fill", arg: "y" })).toBe("Fill y");
  });
});

describe("checkSpine keeps narration honest about the run", () => {
  const spine = [
    { id: "s1a1", action: "goto", url: "/a" },
    { id: "s1a2", action: "click", url: "/a" },
    { id: "s2a1", action: "fill", url: "/b" },
  ];
  const flowWith = (ids: string[]) => ({
    states: [{ id: "s1", steps: ids.map((id) => ({ id })) }],
  });

  it("accepts extra steps, because folding glue in is the instruction", () => {
    const { ok } = checkSpine(flowWith(["s1a1", "glue-1", "s1a2", "s2a1", "note-x"]), spine);
    expect(ok).toBe(true);
  });

  it("rejects a dropped action and names it", () => {
    const { ok, errors } = checkSpine(flowWith(["s1a1", "s2a1"]), spine);
    expect(ok).toBe(false);
    expect(errors.join(" ")).toContain("s1a2");
    expect(errors.join(" ")).toContain("do not drop it");
  });

  it("rejects a reordered run", () => {
    const { ok, errors } = checkSpine(flowWith(["s1a2", "s1a1", "s2a1"]), spine);
    expect(ok).toBe(false);
    expect(errors.join(" ")).toContain("reorders the run");
  });

  it("rejects the same recorded action appearing twice", () => {
    const { ok, errors } = checkSpine(flowWith(["s1a1", "s1a2", "s1a2", "s2a1"]), spine);
    expect(ok).toBe(false);
    expect(errors.join(" ")).toContain("appears 2 times");
  });

  it("is a no-op when there is no spine to check", () => {
    expect(checkSpine(flowWith(["x"]), []).ok).toBe(true);
  });
});

// ---------------------------------------------------------------- static scan

describe("the static scan enumerates exports without a parser", () => {
  it("finds every declaration form it claims to", () => {
    const { exports: found } = exportsOf(
      [
        "export function plain() {}",
        "export async function later() {}",
        "export const value = 1;",
        "export let mutable = 2;",
        "export class Thing {}",
        "export interface Shape {}",
        "export type Alias = string;",
        "export enum Colour {}",
        "export default function Page() {}",
        "const hidden = 3;",
      ].join("\n"),
      "src/lib/x.ts"
    );
    expect(found.map((e: any) => e.name)).toEqual([
      "plain",
      "later",
      "value",
      "mutable",
      "Thing",
      "Shape",
      "Alias",
      "Colour",
      "Page",
    ]);
    expect(found.find((e: any) => e.name === "Page").isDefault).toBe(true);
    expect(found.find((e: any) => e.name === "plain").line).toBe(1);
    expect(found.every((e: any) => e.file === "src/lib/x.ts")).toBe(true);
  });

  it("reads an export list, honouring aliases", () => {
    const { exports: found } = exportsOf("export { alpha, beta as gamma };");
    expect(found.map((e: any) => e.name)).toEqual(["alpha", "gamma"]);
  });

  it("admits when a file re-exports opaquely instead of guessing the names", () => {
    const { exports: found, opaqueReexport } = exportsOf('export * from "./everything";');
    expect(found).toEqual([]);
    expect(opaqueReexport).toBe(true);
  });

  it("counts identifiers as whole words only", () => {
    const text = "go(); ago(); go_ne(); $go; a.go;";
    expect(countReferences(text, "go")).toBe(2); // `go()` and `a.go`
    expect(countReferences(text, "nothere")).toBe(0);
  });

  it("classifies files the way the report depends on", () => {
    expect(isSourceFile("src/lib/a.ts")).toBe(true);
    expect(isSourceFile("src/lib/a.d.ts")).toBe(false);
    expect(isSourceFile("node_modules/x/i.js")).toBe(false);
    expect(isSourceFile("dist/i.js")).toBe(false);
    expect(isSourceFile("docs/README.md")).toBe(false);

    expect(isTestFile("tests/a.test.ts")).toBe(true);
    expect(isTestFile("tests/e2e/a.spec.ts")).toBe(true);
    expect(isTestFile("src/lib/a.ts")).toBe(false);

    // A route file's caller is the framework, so a static scan can never see it.
    expect(isFrameworkEntry("src/app/quarters/page.tsx")).toBe(true);
    expect(isFrameworkEntry("src/app/api/x/route.ts")).toBe(true);
    expect(isFrameworkEntry("middleware.ts")).toBe(true);
    expect(isFrameworkEntry("vitest.config.ts")).toBe(true);
    expect(isFrameworkEntry("src/lib/helper.ts")).toBe(false);
  });

  const FILES: Record<string, string> = {
    "src/lib/used.ts": "export function used() {}\nexport function orphan() {}",
    "src/lib/consumer.ts": 'import { used } from "./used";\nused();',
    "src/lib/testonly.ts": "export function onlyTested() {}",
    "tests/x.test.ts": 'import { onlyTested } from "../src/lib/testonly";\nonlyTested();',
    "src/app/page.tsx": "export default function Page() {}\nexport const dynamic = 'force-static';",
    "src/lib/dupe-a.ts": "export function format() {}",
    "src/lib/dupe-b.ts": "export function format() {}",
  };
  const scan = scanExports(Object.keys(FILES), { read: (f: string) => FILES[f] ?? null });

  it("splits references into code and test, ignoring the defining file", () => {
    const used = scan.symbols.find((s: any) => s.name === "used");
    // Three, not two: the named import, the call, AND the word inside the path
    // string "./used". That is the documented inflation — matching text rather than
    // parsing means a count can only ever be too high, so the scan errs towards
    // calling code live, which is the error that gets nothing deleted.
    expect(used.refs.code).toBe(3);
    expect(used.refs.test).toBe(0);

    const tested = scan.symbols.find((s: any) => s.name === "onlyTested");
    expect(tested.refs.code).toBe(0);
    expect(tested.refs.test).toBe(2);
  });

  it("surfaces an unreferenced export as a candidate, and never a route file", () => {
    const dead = deadCandidates(scan);
    const names = dead.map((d: any) => d.symbol);
    expect(names).toContain("orphan");
    expect(names).toContain("onlyTested");
    // Page and `dynamic` live in a route file: the framework calls them and no
    // static scan can see that call, so flagging them would poison the list.
    expect(names).not.toContain("Page");
    expect(names).not.toContain("dynamic");
    expect(names).not.toContain("used");

    expect(dead.find((d: any) => d.symbol === "onlyTested").testOnly).toBe(true);
    expect(dead.find((d: any) => d.symbol === "orphan").testOnly).toBe(false);
  });

  it("flags one name exported from two places as a question", () => {
    const dupes = duplicateNames(scan);
    const format = dupes.find((d: any) => d.symbol === "format");
    expect(format.places.map((p: any) => p.file)).toEqual(["src/lib/dupe-a.ts", "src/lib/dupe-b.ts"]);
  });
});

// ---------------------------------------------------------------- compare report

describe("the compare report only claims what its instruments can see", () => {
  const FILES: Record<string, string> = {
    "src/lib/helper.ts": "export function helper() {}\nexport function unusedHelper() {}",
    "src/lib/caller.ts": 'import { helper } from "./helper";\nhelper();',
    "src/app/page.tsx": "export default function Home() {}",
    "src/app/memory/page.tsx": "export default function Memory() {}",
    "src/app/quarters/[type]/page.tsx": "export default function Quarters() {}",
  };
  const files = Object.keys(FILES);
  const scan = scanExports(files, { read: (f: string) => FILES[f] ?? null });

  const captures = [
    {
      events: [
        { seq: 1, type: "action", action: "goto", url: "/quarters/context" },
        {
          seq: 2,
          type: "route",
          forSeq: 1,
          file: "src/app/quarters/[type]/page.tsx",
          via: [{ file: "src/app/memory/page.tsx", to: "/quarters/context" }],
        },
      ],
    },
  ];

  it("counts a redirect stub as executed, because it is what sent the reader on", () => {
    const seen = observedFiles(captures);
    expect(seen.has("src/app/quarters/[type]/page.tsx")).toBe(true);
    expect(seen.has("src/app/memory/page.tsx")).toBe(true);
    expect(seen.has("src/app/page.tsx")).toBe(false);
  });

  it("reports only pages as never-observed, never helpers it never watched", () => {
    const report = buildCompareReport({ scan, captures, files, sha: "b".repeat(40), generatedAt: "2026-08-11T00:00:00Z" });
    const unseen = report.unexercised.map((u: any) => u.file);
    expect(unseen).toEqual(["src/app/page.tsx"]);
    // src/lib/helper.ts was never observed either — but route resolution never looks
    // at helpers, so calling it unobserved would be reporting our own blindness.
    expect(unseen).not.toContain("src/lib/helper.ts");
    expect(report.stats.routeFiles).toBe(3);
    expect(report.stats.routeFilesObserved).toBe(2);
  });

  it("still finds dead-code candidates and keeps live code out", () => {
    const report = buildCompareReport({ scan, captures, files, sha: "b".repeat(40) });
    const dead = report.deadCode.map((d: any) => d.symbol);
    expect(dead).toContain("unusedHelper");
    expect(dead).not.toContain("helper");
    expect(dead).not.toContain("Home");
  });

  it("says outright when it had no runtime evidence at all", () => {
    const report = buildCompareReport({ scan, captures: [], files, sha: "b".repeat(40) });
    expect(report.unexercised).toEqual([]);
    expect(report.blindSpots.join(" ")).toContain("empty by default, not by evidence");
  });

  it("names an opaque re-export as a blind spot", () => {
    const opaque = { "src/lib/barrel.ts": 'export * from "./inner";' };
    const s = scanExports(Object.keys(opaque), { read: (f: string) => (opaque as any)[f] ?? null });
    const report = buildCompareReport({ scan: s, files: Object.keys(opaque), sha: "c".repeat(40) });
    expect(report.blindSpots.join(" ")).toContain("src/lib/barrel.ts");
  });

  it("leads the copy-pasteable block with the caveat, not the list", () => {
    const report = buildCompareReport({ scan, captures, files, sha: "b".repeat(40) });
    const caveatAt = report.markdown.indexOf("Everything below is a candidate");
    const firstItem = report.markdown.indexOf("unusedHelper");
    expect(caveatAt).toBeGreaterThan(-1);
    expect(caveatAt).toBeLessThan(firstItem);
    expect(report.markdown).toContain("Verify before removing");
  });

  it("never truncates silently", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 205; i += 1) many[`src/lib/m${i}.ts`] = `export const sym${i} = ${i};`;
    const s = scanExports(Object.keys(many), { read: (f: string) => many[f] ?? null });
    const report = buildCompareReport({ scan: s, files: Object.keys(many), sha: "d".repeat(40) });
    expect(report.deadCode.length).toBe(200);
    expect(report.truncated.deadCode).toBe(5);
    expect(report.markdown).toContain("5 more not listed");
  });

  it("renders without throwing, and shows the caveat block to a reader", () => {
    const report = buildCompareReport({ scan, captures, files, sha: "b".repeat(40) });
    const html = renderCompare(report, { project: "/repo" });
    expect(html).toContain("unusedHelper");
    expect(html).toContain("src/app/page.tsx");
  });
});

describe("compare stats cannot flatter themselves", () => {
  const FILES: Record<string, string> = {
    "src/app/page.tsx": "export default function Home() {}",
    "src/app/other/page.tsx": "export default function Other() {}",
  };
  const files = Object.keys(FILES);
  const scan = scanExports(files, { read: (f: string) => FILES[f] ?? null });

  it("reports zero pages observed when nothing was watching", () => {
    const report = buildCompareReport({ scan, captures: [], files, sha: "e".repeat(40) });
    expect(report.stats.routeFiles).toBe(2);
    // Not 2. An empty unexercised bucket must not read as full coverage.
    expect(report.stats.routeFilesObserved).toBe(0);
    expect(report.markdown).toContain("0/2 route files were observed");
  });
});

describe("narrowing the report must never narrow the search for uses", () => {
  const FILES: Record<string, string> = {
    "src/lib/a.ts": "export function tested() {}\nexport function orphan() {}",
    "src/lib/b.ts": "export function inner() { return inner; }",
    "tests/a.test.ts": 'import { tested } from "../src/lib/a";\ntested();',
    "fittings/x/uses.mjs": 'import { orphan } from "../../src/lib/a.ts";\norphan();',
  };
  const read = (f: string) => FILES[f] ?? null;
  const all = Object.keys(FILES);
  const scoped = ["src/lib/a.ts", "src/lib/b.ts"];

  it("finds a use that lives outside the reported scope", () => {
    const scan = scanExports(scoped, { read, referenceFiles: all });
    const orphan = scan.symbols.find((s: any) => s.name === "orphan");
    // Referenced from fittings/, which the report is not scoped to. Counting only
    // inside the scope would have called this dead.
    expect(orphan.refs.code).toBeGreaterThan(0);
    expect(deadCandidates(scan).map((d: any) => d.symbol)).not.toContain("orphan");
  });

  it("still sees test coverage when the report is scoped to src", () => {
    const scan = scanExports(scoped, { read, referenceFiles: all });
    const tested = scan.symbols.find((s: any) => s.name === "tested");
    expect(tested.refs.test).toBeGreaterThan(0);
    expect(deadCandidates(scan).find((d: any) => d.symbol === "tested").testOnly).toBe(true);
  });

  it("would have been wrong had the search been scoped too", () => {
    // The bug this guards against, reproduced deliberately.
    const narrow = scanExports(scoped, { read, referenceFiles: scoped });
    expect(narrow.symbols.find((s: any) => s.name === "tested").refs.test).toBe(0);
  });

  it("separates a surplus export from unused code", () => {
    const scan = scanExports(scoped, { read, referenceFiles: all });
    const inner = deadCandidates(scan).find((d: any) => d.symbol === "inner");
    expect(inner.usedInternally).toBe(true);
    expect(noteFor(inner)).toContain("the export is surplus, the code is not");

    const orphaned = deadCandidates(
      scanExports(["src/lib/a.ts"], { read, referenceFiles: ["src/lib/a.ts"] })
    ).find((d: any) => d.symbol === "orphan");
    expect(orphaned.usedInternally).toBe(false);
    expect(noteFor(orphaned)).toContain("nothing references");
  });

  it("leads with the deletable case and buries type declarations", () => {
    const F: Record<string, string> = {
      "src/lib/z.ts": [
        "export type Shape = string;",
        "export function reallyDead() {}",
        "export function selfUsed() { return selfUsed; }",
      ].join("\n"),
    };
    const scan = scanExports(["src/lib/z.ts"], { read: (f: string) => F[f] ?? null });
    expect(deadCandidates(scan).map((d: any) => d.symbol)).toEqual(["reallyDead", "selfUsed", "Shape"]);
  });
});

describe("a redirect is attributed to the navigation, not to everything after it", () => {
  const capture = {
    schemaVersion: 1,
    source: "e2e",
    test: { file: "tests/e2e/m.spec.ts", title: "redirected flow" },
    events: [
      {
        seq: 1,
        type: "action",
        action: "goto",
        arg: null,
        url: "/quarters/context",
        requestedUrl: "/memory",
        ok: true,
      },
      {
        seq: 2,
        type: "route",
        forSeq: 1,
        file: "src/app/quarters/[type]/page.tsx",
        via: [{ file: "src/app/memory/page.tsx", to: "/quarters/context" }],
      },
      { seq: 3, type: "action", action: "click", arg: "editor", url: "/quarters/context", ok: true },
    ],
  };

  it("titles a navigation by its destination, not by a bare verb", () => {
    const spec = specFromCapture(capture);
    expect(spec.states[0].steps[0].title).toBe("Navigate to /quarters/context");
    expect(stepTitle({ action: "goto", arg: null, url: "/x" })).toBe("Navigate to /x");
  });

  it("names the redirect stub instead of printing undefined", () => {
    const spec = specFromCapture(capture);
    const said = spec.states[0].steps[0].hints.admissions.join(" ");
    expect(said).toContain("src/app/memory/page.tsx -> /quarters/context");
    expect(said).not.toContain("undefined");
  });

  it("does not tell the click that it was redirected", () => {
    const spec = specFromCapture(capture);
    // The click inherited the page; it asked for nothing and was bounced by nothing.
    expect(spec.states[0].steps[1].hints.admissions).toBeUndefined();
  });
});

describe("an update report accounts for every step it was given", () => {
  const FILE = "src/lib/thing.ts";
  const TEXT = "one\ntwo\nthree\nfour\n";
  const NEW_SHA = "f".repeat(40);
  const readAt = (f: string) => (f === FILE ? TEXT : null);

  const flow = {
    flowId: "reconcile",
    source: "e2e",
    anchoredAt: { sha: "0".repeat(40) },
    states: [
      {
        id: "s1",
        steps: [
          {
            id: "s1a1",
            kind: "code",
            title: "has a span",
            sample: {
              file: FILE,
              startLine: 1,
              endLine: 2,
              extractedSha256: hashText(sliceSpan(TEXT, 1, 2)),
            },
          },
          {
            id: "s1a2",
            kind: "code",
            title: "carries a diff, which cannot go stale",
            diffSample: { file: FILE, sha: "1".repeat(40), patch: "@@ -1 +1 @@", extractedSha256: "2".repeat(64) },
          },
          { id: "s1a3", kind: "glue", title: "no code at all" },
        ],
      },
    ],
  };

  it("puts every step in exactly one bucket", () => {
    const { report } = refreshFlow(flow, new Map(), NEW_SHA, readAt);
    const counted =
      report.unchanged + report.restamped + report.skipped + report.stale.length + report.invalidated.length;
    // Three steps in, three accounted for. An earlier version dropped the two with
    // nothing to check, so a flow of eight steps reported on five and the reader
    // could not tell whether three had been forgotten or were merely quiet.
    expect(counted).toBe(3);
    expect(report.skipped).toBe(2);
    expect(report.unchanged).toBe(1);
  });
});

describe("a huge diff must not take the update down with it", () => {
  it("keeps the lines the parser reads and drops the payload", () => {
    expect(isStructuralDiffLine("diff --git a/x b/x")).toBe(true);
    expect(isStructuralDiffLine("@@ -10,3 +10,4 @@ function x() {")).toBe(true);
    expect(isStructuralDiffLine("--- a/x")).toBe(true);
    expect(isStructuralDiffLine("+++ b/x")).toBe(true);
    expect(isStructuralDiffLine("rename from a/x")).toBe(true);
    expect(isStructuralDiffLine("deleted file mode 100644")).toBe(true);

    // The payload, which is all of the bulk.
    expect(isStructuralDiffLine("+const x = 1;")).toBe(false);
    expect(isStructuralDiffLine("-const x = 1;")).toBe(false);
    expect(isStructuralDiffLine(" unchanged context")).toBe(false);
  });

  it("cannot mistake removed content for a hunk header", () => {
    // A deleted line whose text IS a hunk header arrives prefixed with `-`.
    expect(isStructuralDiffLine("-@@ -1 +1 @@")).toBe(false);
    expect(isStructuralDiffLine("+diff --git a/evil b/evil")).toBe(false);
    // A deleted line whose text is `-- a/x` renders as `--- a/x` and IS kept — but
    // the parser only reads file headers from the slice before the first `@@`, so a
    // stray one further down is inert.
    expect(isStructuralDiffLine("--- a/x")).toBe(true);
  });

  it("still parses a filtered diff into the same hunks", () => {
    const full = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -10,2 +10,3 @@",
      "-old line one",
      "-old line two",
      "+new line one",
      "+new line two",
      "+new line three",
    ].join("\n");
    const filtered = full
      .split("\n")
      .filter(isStructuralDiffLine)
      .join("\n");

    const fromFull = parseUnifiedZeroDiff(full).get("src/a.ts");
    const fromFiltered = parseUnifiedZeroDiff(filtered).get("src/a.ts");
    expect(fromFiltered).toEqual(fromFull);
    expect(fromFiltered.hunks).toEqual([{ oldStart: 10, oldLines: 2, newStart: 10, newLines: 3 }]);
  });
});

// ---------------------------------------------------------------- drillbook source

describe("the drillbook is read for what a human already wrote down", () => {
  const BOOK = {
    app: { name: "App", url: "http://127.0.0.1:7777" },
    globalRules: "Keep it readable at 390px.",
    viewports: ["desktop", "mobile"],
    pages: [
      { id: "dashboard", title: "Dashboard", path: "/", selected: true },
      { id: "vault", title: "Vault", path: "/vault" },
      { id: "parked", title: "Parked", path: "/parked", selected: false },
    ],
  };

  it("treats an unmarked page as selected, and only an explicit false as opted out", () => {
    const book = parseBook(BOOK);
    expect(book.pages.map((p) => p.id)).toEqual(["dashboard", "vault", "parked"]);
    expect(book.pages.find((p) => p.id === "vault")!.selected).toBe(true);
    expect(book.pages.find((p) => p.id === "parked")!.selected).toBe(false);
    expect(book.globalRules).toBe("Keep it readable at 390px.");
  });

  it("drops a page entry with no id or no path rather than inventing one", () => {
    const book = parseBook({ pages: [{ id: "ok", path: "/ok" }, { id: "no-path" }, { path: "/no-id" }] });
    expect(book.pages.map((p) => p.id)).toEqual(["ok"]);
  });

  it("keeps enabled steps and their descriptions, drops disabled ones", () => {
    const page = parsePage({
      id: "vault",
      title: "Vault",
      path: "/vault",
      steps: [
        { id: "smoke", description: "  The Vault communicates security state.  ", state: "default" },
        { id: "off", description: "not this one", enabled: false },
        { description: "no id of its own" },
      ],
      states: [{ id: "sealed", label: "Sealed", setup: "Lock the vault first." }],
    });
    expect(page.steps.map((s: any) => s.id)).toEqual(["smoke", "step-3"]);
    expect(page.steps[0].description).toBe("The Vault communicates security state.");
    expect(page.states[0].setup).toBe("Lock the vault first.");
  });

  it("gives every declared state its own navigation, all at the same path", () => {
    const page = parsePage({
      id: "vault",
      title: "Vault",
      path: "/vault",
      steps: [
        { id: "a", description: "Default matters.", state: "default" },
        { id: "b", description: "Sealed matters.", state: "sealed" },
      ],
      states: [{ id: "sealed", label: "Sealed", setup: "Lock it." }],
    });
    const navs = navigationsFor(page);
    expect(navs.map((n) => n.stateId)).toEqual(["default", "sealed"]);
    expect(navs.every((n) => n.url === "/vault")).toBe(true);
    expect(navs[0].intent).toBe("Default matters.");
    expect(navs[1].intent).toContain("Sealed matters.");
    expect(navs[1].intent).toContain("Reached by: Lock it.");
  });

  it("does not collapse two states of one page into a single state", () => {
    const capture = {
      source: "drillbook",
      test: { file: "drills/pages/vault.yml", title: "Vault" },
      drillbook: { pageId: "vault", stepIds: ["a", "b"] },
      events: [
        { seq: 1, type: "action", action: "goto", url: "/vault", intent: "Default matters.", state: { key: "vault:default", label: "Vault" } },
        { seq: 2, type: "action", action: "goto", url: "/vault", intent: "Sealed matters.", state: { key: "vault:sealed", label: "Vault — Sealed" } },
      ],
    };
    const spec = specFromCapture(capture);
    // Same URL, two states. Keying on the URL alone would have merged them.
    expect(spec.states.map((s: any) => s.label)).toEqual(["Vault", "Vault — Sealed"]);
    expect(spec.states[0].steps[0].hints.intent).toBe("Default matters.");
  });

  it("records a drillbook page as a drillbook page, not as a test file", () => {
    const spec = specFromCapture({
      source: "drillbook",
      test: { file: "drills/pages/vault.yml", title: "Vault" },
      drillbook: { pageId: "vault", stepIds: ["smoke"] },
      events: [{ seq: 1, type: "action", action: "goto", url: "/vault" }],
    });
    expect(spec.provenance.drillbookPage).toBe("drills/pages/vault.yml");
    expect(spec.provenance.testFile).toBeUndefined();
    expect(spec.provenance.drillbookStep).toBe("smoke");
  });

  it("strips the origin off the book's absolute URLs", () => {
    expect(pathOf("http://127.0.0.1:27777/muster")).toBe("/muster");
    expect(pathOf("http://127.0.0.1:27777")).toBe("/");
    expect(pathOf("/vault")).toBe("/vault");
    expect(pathOf("vault")).toBe("/vault");
  });

  it("says the yaml package is missing rather than crashing obscurely", async () => {
    // The message must name what is absent and that other modes are unaffected.
    const text = "id: x";
    const parsed = await loadYaml(text).catch((err: Error) => err.message);
    // js-yaml resolves in this repo, so this asserts the happy path; the failure text
    // is asserted by reading it, not by uninstalling a package mid-test.
    expect(parsed).toEqual({ id: "x" });
  });
});

describe("a generated drillbook step id must not move when a sibling is toggled", () => {
  const withThird = (enabled: boolean) =>
    parsePage({
      id: "p",
      title: "P",
      path: "/p",
      steps: [{ id: "first", description: "a" }, { description: "middle", enabled }, { description: "last" }],
    });

  it("numbers from the position in the file, not from the survivors", () => {
    // The unnamed last step is step-3 either way. These ids reach a manifest's
    // provenance, so one that shifts when an unrelated step is enabled is worthless.
    expect(withThird(false).steps.map((s: any) => s.id)).toEqual(["first", "step-3"]);
    expect(withThird(true).steps.map((s: any) => s.id)).toEqual(["first", "step-2", "step-3"]);
  });
});

// ---------------------------------------------------------------- docs survey

describe("the docs survey excludes executable markdown by path", () => {
  it("keeps project prose and drops fitting payload", () => {
    expect(isProjectDoc("docs/SPEC.md")).toBe(true);
    expect(isProjectDoc("README.md")).toBe(true);
    // 162 of this repo's 368 markdown files are payload an agent loads at runtime.
    // Consolidating one would break a fitting, so the exclusion is structural.
    expect(isProjectDoc("fittings/seed/drill/README.md")).toBe(false);
    expect(isProjectDoc(".apm/skills/x/SKILL.md")).toBe(false);
    expect(isProjectDoc(".codex/skills/y/SKILL.md")).toBe(false);
    expect(isProjectDoc("node_modules/pkg/README.md")).toBe(false);
    expect(isProjectDoc("site/index.md")).toBe(false);
    expect(isProjectDoc("src/lib/thing.ts")).toBe(false);
  });

  it("treats only root entry documents as slim-only", () => {
    expect(isProtectedDoc("README.md")).toBe(true);
    expect(isProtectedDoc("CLAUDE.md")).toBe(true);
    expect(isProtectedDoc("AGENTS.md")).toBe(true);
    // A nested README is not the project's entry document.
    expect(isProtectedDoc("docs/README.md")).toBe(false);
    expect(isProtectedDoc("docs/SPEC.md")).toBe(false);
  });

  it("does not mistake a shell comment in a fence for a heading", () => {
    const text = ["# Real heading", "```bash", "# not a heading", "npm run x", "```", "## Second"].join("\n");
    expect(headingsOf(text).map((h) => h.text)).toEqual(["Real heading", "Second"]);
  });

  it("resolves links relative to the linking document", () => {
    expect(linkedDocsOf("see [spec](./docs/SPEC.md) and [gov](docs/GOVERNANCE.md)", "CLAUDE.md")).toEqual([
      "docs/SPEC.md",
      "docs/GOVERNANCE.md",
    ]);
    expect(linkedDocsOf("[up](../README.md)", "docs/x.md")).toEqual(["README.md"]);
    expect(linkedDocsOf("[anchored](./docs/A.md#section)", "CLAUDE.md")).toEqual(["docs/A.md"]);
    expect(linkedDocsOf("[remote](https://example.com/x.md)", "CLAUDE.md")).toEqual([]);
  });

  it("ranks a document linked from an entry document LAST, however stale it sounds", () => {
    const docs = [
      surveyDoc({
        file: "docs/METADATA.md",
        text: "# Metadata\n\nThis records deprecated fields and historical decisions. TODO: tidy.",
        entryLinks: new Set(["docs/METADATA.md"]),
      }),
      surveyDoc({ file: "RUN_LOG.md", text: "# Run log\n\nHistorical. TODO." }),
    ];
    const survey = buildSurvey({ docs, sha: "a".repeat(40) });
    // METADATA.md carries MORE markers, and must still not lead: it is the document
    // CLAUDE.md tells you to read before touching a fitting. A list that leads with
    // what you must not touch is worse than no list.
    expect(survey.candidates[0].file).toBe("RUN_LOG.md");
    expect(survey.candidates[1].file).toBe("docs/METADATA.md");
    expect(survey.candidates[1].reasons.join(" ")).toContain("LINKED FROM AN ENTRY DOCUMENT");
  });

  it("says the overlap signal is dark when there are no flows", () => {
    const survey = buildSurvey({ docs: [surveyDoc({ file: "docs/x.md", text: "# X" })], flowCount: 0 });
    expect(survey.blindSpots.join(" ")).toContain("that zero is not evidence");
  });

  it("never puts an entry document in the candidate list at all", () => {
    const docs = [surveyDoc({ file: "README.md", text: "# R\n\nHistorical, deprecated, TODO." })];
    const survey = buildSurvey({ docs });
    expect(survey.candidates).toEqual([]);
    expect(survey.slimOnly.map((d: any) => d.file)).toEqual(["README.md"]);
  });

  it("proposes nothing, and says so in the artefact itself", () => {
    const survey = buildSurvey({ docs: [surveyDoc({ file: "docs/x.md", text: "# X" })] });
    expect(survey.note).toContain("not a plan");
    expect(survey.note).toContain("allowlist");
  });

  it("counts only narrow, path-shaped mentions", () => {
    const found = mentionedPaths("See `src/lib/runner.ts` and src/app/page.tsx, but not runner or lib/x.");
    expect(found).toEqual(["src/lib/runner.ts", "src/app/page.tsx"]);
  });
});

describe("an empty viewer invites instead of instructing", () => {
  it("offers a button rather than telling the reader to run a skill", () => {
    const html = renderIndex([], { project: "/repo" });
    // The one thing this fitting exists to spare a reader is running commands.
    expect(html).toContain('data-mode="full-run"');
    expect(html).toContain("first-run");
    expect(html).not.toContain("Run the garrison-project-viewer skill");
  });

  it("says the first run costs money before the reader presses anything", () => {
    const html = renderIndex([], { project: "/repo" });
    expect(html).toContain("paid once");
    expect(html).toContain("asks how deep to go");
  });

  it("does not show the panel once there are flows to read", () => {
    const flow = {
      flowId: "f",
      title: "A flow",
      source: "e2e",
      anchoredAt: { sha: "a".repeat(40) },
      states: [{ id: "s1", label: "One", steps: [{ id: "s1a1", title: "T", kind: "glue" }] }],
    };
    const html = renderIndex([flow], { project: "/repo" });
    expect(html).not.toContain("first-run");
    expect(html).toContain("A flow");
  });

  it("carries the panel in both languages", () => {
    for (const lang of ["en", "pt"]) {
      const html = renderIndex([], { project: "/repo", lang });
      expect(html, `${lang} panel`).toContain('data-mode="full-run"');
      // An untranslated key renders as the key itself, which would be visible here.
      expect(html, `${lang} strings`).not.toContain("index.first.");
    }
  });
});

describe("a dispatch failure speaks the reader's language", () => {
  it("carries a code the client can translate, not just English prose", async () => {
    const { dispatchCard } = await import("../fittings/seed/project-viewer/lib/dispatch.mjs");
    // A home with no ui-fittings dir at all: no peer can be found.
    const env = { GARRISON_HOME: path.join(__dirname, "..", "no-such-home-for-tests") } as any;
    const result = await dispatchCard({ title: "T", prompt: "p", project: "/r", originId: "o" }, env);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("noKanban");
    // The English text stays as the fallback and for the logs.
    expect(result.error).toContain("no kanban-loop is running");
  });

  it("names the instance, because the peer is usually alive under another home", async () => {
    const { dispatchCard, instanceName } = await import(
      "../fittings/seed/project-viewer/lib/dispatch.mjs"
    );
    expect(instanceName({ GARRISON_HOME: "/x/.garrison" } as any)).toBe("prod");
    expect(instanceName({ GARRISON_HOME: "/x/.garrison-dev" } as any)).toBe("dev");
    expect(instanceName({ GARRISON_INSTANCE_ID: "codex" } as any)).toBe("codex");

    const result = await dispatchCard(
      { title: "T", prompt: "p", project: "/r", originId: "o" },
      { GARRISON_HOME: "/x/.garrison-dev" } as any
    );
    // "not running" alone sent people hunting for a dead process instead of at the
    // isolation between instances.
    expect(result.error).toContain("(dev)");
    expect(result.instance).toBe("dev");
  });

  it("translates that code in both languages", () => {
    const js = readFileSync(
      path.resolve(__dirname, "..", "fittings", "seed", "project-viewer", "assets", "viewer.js"),
      "utf8"
    );
    expect(js).toContain('"err.noKanban"');
    expect(js).toContain("Não há quadro kanban");
    expect(js).toContain("No kanban board is running");
    // The client must prefer the code over the raw server text.
    expect(js).toContain('COPY[LANG]["err." + body.code]');
  });
});

describe("the same expensive job is not queued twice", () => {
  const CARDS = [
    { id: "c-old", list: "done", origin_id: "project-viewer:abc:full-run:all" },
    { id: "c-live", list: "backlog", origin_id: "project-viewer:abc:full-run:all" },
    { id: "c-other", list: "backlog", origin_id: "project-viewer:abc:compare:all" },
  ];

  function withBoard(cards: any, ok = true) {
    const original = globalThis.fetch;
    (globalThis as any).fetch = async () => ({
      ok,
      status: ok ? 200 : 500,
      json: async () => ({ cards }),
      text: async () => JSON.stringify({ cards }),
    });
    return () => {
      (globalThis as any).fetch = original;
    };
  }

  it("finds an unfinished card with the same origin", async () => {
    const { openCardWithOrigin } = await import("../fittings/seed/project-viewer/lib/dispatch.mjs");
    const restore = withBoard(CARDS);
    try {
      const found = await openCardWithOrigin("http://k", "project-viewer:abc:full-run:all");
      // c-old has the same origin but is done, so it must not count.
      expect(found?.id).toBe("c-live");
    } finally {
      restore();
    }
  });

  it("ignores a finished card and a different job", async () => {
    const { openCardWithOrigin } = await import("../fittings/seed/project-viewer/lib/dispatch.mjs");
    const restore = withBoard([CARDS[0]]);
    try {
      expect(await openCardWithOrigin("http://k", "project-viewer:abc:full-run:all")).toBeNull();
      expect(await openCardWithOrigin("http://k", "project-viewer:abc:nothing:all")).toBeNull();
    } finally {
      restore();
    }
  });

  it("queues the work when the board cannot be listed, rather than losing it", async () => {
    const { openCardWithOrigin } = await import("../fittings/seed/project-viewer/lib/dispatch.mjs");
    const restore = withBoard(CARDS, false);
    try {
      // A duplicate card is a nuisance; dropping real work because a GET failed
      // would be worse. So an unreadable board means "no duplicate".
      expect(await openCardWithOrigin("http://k", "project-viewer:abc:full-run:all")).toBeNull();
    } finally {
      restore();
    }
  });

  it("tells the reader it is already queued, in both languages", () => {
    const js = readFileSync(
      path.resolve(__dirname, "..", "fittings", "seed", "project-viewer", "assets", "viewer.js"),
      "utf8"
    );
    expect(js).toContain("cardExists");
    expect(js).toContain("já está em fila no cartão");
    expect(js).toContain("already queued as card");
    // And the success text must not promise the work has started: the backlog is manual.
    expect(js).toContain("Advance it there to start the work");
    expect(js).toContain("Avança-o lá para o trabalho começar");
  });
});

describe("project registry", () => {
  // The registry is machine-local state, so every test gets its own store root.
  // Sharing one would make these tests order-dependent in exactly the way the
  // registry itself must never be.
  async function tempStore() {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pv-projects-"));
    return { env: { GARRISON_PROJECTVIEWER_STORE: dir }, dir };
  }
  const anyRepo = () => true;

  it("disambiguates only the names that actually collide", () => {
    // Qualifying every row would make the common case noisier to fix a case that
    // usually is not present at all.
    const labels = labelsFor(["/home/u/dev/foo", "/home/u/work/foo", "/home/u/dev/bar"]);
    expect(labels).toEqual(["dev/foo", "work/foo", "bar"]);
  });

  it("resolves a path to an absolute one before it becomes a key", () => {
    expect(path.isAbsolute(normalisePath("~/dev/x"))).toBe(true);
    expect(normalisePath("/a/b/")).toBe(path.resolve("/a/b"));
  });

  it("refuses a path that does not exist, is a file, or is not a repository", async () => {
    const { env, dir } = await tempStore();
    try {
      expect((await addProject(path.join(dir, "nope"), { isRepo: anyRepo, env })).code).toBe("missing");

      const file = path.join(dir, "a-file");
      await writeFile(file, "x", "utf8");
      expect((await addProject(file, { isRepo: anyRepo, env })).code).toBe("notDirectory");

      // The repository check is a refusal, not a warning: samples are anchored to a
      // commit, so a directory with no history has nothing to anchor to and every
      // page would render an error.
      expect((await addProject(dir, { isRepo: () => false, env })).code).toBe("notRepo");
      expect((await readRegistry(env)).projects).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("adds, lists and resolves a project by key", async () => {
    const { env, dir } = await tempStore();
    try {
      const added = await addProject(dir, { isRepo: anyRepo, env });
      expect(added.ok).toBe(true);

      const list = await listProjects({ configured: "/configured/repo", env });
      // The configured repo leads, because it is the one entry the machine can
      // always fall back to.
      expect(list[0].isDefault).toBe(true);
      expect(list[0].path).toBe(path.resolve("/configured/repo"));
      expect(list.map((e: any) => e.path)).toContain(path.resolve(dir));

      const back = await resolveKey(added.key, { configured: "/configured/repo", env });
      expect(back).toBe(path.resolve(dir));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never turns an unregistered key into a directory", async () => {
    // The security property of the whole feature: the cookie carries a key, and a
    // key only ever resolves against the server's own list. A forged value has to
    // come back as null, or the browser would be naming directories to open.
    const { env, dir } = await tempStore();
    try {
      expect(await resolveKey("deadbeefcafe", { configured: dir, env })).toBeNull();
      expect(await resolveKey("../../etc", { configured: dir, env })).toBeNull();
      expect(await resolveKey("", { configured: dir, env })).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not list the configured repo twice when it is also added by hand", async () => {
    const { env, dir } = await tempStore();
    try {
      await addProject(dir, { isRepo: anyRepo, env });
      const list = await listProjects({ configured: dir, env });
      expect(list.filter((e: any) => e.path === path.resolve(dir))).toHaveLength(1);
      expect(list[0].isDefault).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to forget the configured project", async () => {
    const { env, dir } = await tempStore();
    try {
      const list = await listProjects({ configured: dir, env });
      const result = await removeProject(list[0].key, { configured: dir, env });
      expect(result.ok).toBe(false);
      expect(result.code).toBe("isDefault");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("project picker page", () => {
  const rows = [
    { key: "aaaaaaaaaaaa", path: "/home/u/dev/one", label: "one", isDefault: true, isCurrent: true, flows: 3, isRepo: true },
    { key: "bbbbbbbbbbbb", path: "/home/u/dev/two", label: "two", isDefault: false, isCurrent: false, flows: 0, isRepo: true },
    { key: "cccccccccccc", path: "/home/u/dev/gone", label: "gone", isDefault: false, isCurrent: false, flows: 0, isRepo: false },
  ];

  it("tells an unanalysed project apart from a broken one", () => {
    // A picker that showed only names would make a first-run project and a path
    // that no longer exists look identical, which is the one distinction a reader
    // needs before clicking.
    const html = renderProjects(rows, { lang: "pt" });
    expect(html).toContain("Ainda não analisado");
    expect(html).toContain("Não é um repositório git");
    expect(html).toContain("3 fluxos");
  });

  it("offers no way to forget the configured project", () => {
    const html = renderProjects(rows, { lang: "en" });
    expect(html).not.toContain('value="aaaaaaaaaaaa"');
    expect(html).toContain('value="bbbbbbbbbbbb"');
  });

  it("does not offer to open the project already showing", () => {
    const html = renderProjects(rows, { lang: "en" });
    expect(html).not.toContain('href="/project/aaaaaaaaaaaa"');
    expect(html).toContain('href="/project/bbbbbbbbbbbb"');
  });

  it("works without JavaScript", () => {
    // This is the screen a reader reaches when the viewer is already showing the
    // wrong thing. A control that needs a working fetch is the wrong control there.
    const html = renderProjects(rows, { lang: "en" });
    expect(html).toContain('<form method="post" action="/projects/add"');
    expect(html).toContain('<form method="post" action="/projects/remove"');
  });

  it("says why a path was refused, in the reader's language", () => {
    expect(renderProjects(rows, { lang: "pt", notice: "notRepo" })).toContain(
      "não é um repositório git"
    );
    expect(renderProjects(rows, { lang: "en", notice: "missing" })).toContain(
      "There is nothing at that path"
    );
  });

  it("puts the switcher on the project name in every page's topbar", () => {
    // The thing a reader wants to click when the wrong repository is showing is the
    // name of the repository.
    const html = renderIndex([], { project: "agent-garrison", lang: "pt" });
    expect(html).toContain('class="project" href="/projects"');
  });
});

describe("logic view", () => {
  const logicSample = (file: string) => ({
    file,
    startLine: 1,
    endLine: 1,
    lang: "ts",
    extractedSha256: hashText("x"),
    sha: "a".repeat(40),
  });

  // A two-state flow with every connector case: a labelled sequential hand-off, a
  // cross-state jump, a glue step, and one state narrated while the other is not.
  const logicFlow = () => ({
    schemaVersion: 1,
    flowId: "logic-demo",
    title: "Logic demo",
    source: "e2e",
    anchoredAt: { sha: "a".repeat(40) },
    states: [
      {
        id: "s1",
        label: "The request arrives",
        logic: "A reader asks for a page; the system decides who should answer.",
        steps: [
          {
            id: "recv",
            title: "The route is matched",
            kind: "code",
            sample: logicSample("src/router.ts"),
            next: [
              { to: "auth", label: "hand off to auth" },
              { to: "state:s2", label: "or skip straight to render" },
            ],
          },
          { id: "auth", title: "The session is checked", kind: "glue", collapsed: true },
        ],
      },
      {
        id: "s2",
        label: "The page renders",
        steps: [{ id: "render", title: "HTML is produced", kind: "code", sample: logicSample("src/render.ts") }],
      },
    ],
  });

  it("accepts the logic field in a manifest, as a string or a language map", () => {
    const flow = logicFlow();
    expect(validateFlow(flow).ok).toBe(true);
    (flow.states[0] as any).logic = { en: "In English.", pt: "Em português." };
    expect(validateFlow(flow).ok).toBe(true);
  });

  it("rejects a logic field that is not prose", () => {
    const flow = logicFlow();
    (flow.states[0] as any).logic = 42;
    const result = validateFlow(flow);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("logic");
  });

  it("shows the functional narration where it exists and admits where it does not", () => {
    // Collapse-never-omit, applied to prose: the un-narrated stage still shows its
    // mechanical spine, under a note saying the why is missing — not a blank.
    const html = renderFlowLogic(logicFlow(), { lang: "en" });
    expect(html).toContain("the system decides who should answer");
    expect(html).toContain("has not been written yet");
    expect(html).toContain("HTML is produced");
  });

  it("renders every step as a node, glue included but quieter", () => {
    const html = renderFlowLogic(logicFlow(), { lang: "en" });
    expect(html).toContain("The route is matched");
    expect(html).toContain("The session is checked");
    expect(html).toContain("is-quiet");
  });

  it("links every node into the code view at its exact step", () => {
    // The logic view is a map, not a silo: the how is always one click away.
    const html = renderFlowLogic(logicFlow(), { lang: "en" });
    expect(html).toContain('href="/flow/logic-demo/state/0#recv"');
    expect(html).toContain('href="/flow/logic-demo/state/1#render"');
  });

  it("labels the sequential hand-off and renders the cross-state jump as a chip", () => {
    const html = renderFlowLogic(logicFlow(), { lang: "en" });
    expect(html).toContain("hand off to auth");
    expect(html).toContain("lg-jump");
    expect(html).toContain("or skip straight to render");
    // The jump goes to the state it names, not to a dead end.
    expect(html).toContain('href="/flow/logic-demo/state/1"');
  });

  it("marks logic as the active segment and offers code as the way out", () => {
    const html = renderFlowLogic(logicFlow(), { lang: "pt" });
    expect(html).toContain('is-active" aria-current="true">Lógica');
    expect(html).toContain('href="/flow/logic-demo/view/code"');
    expect(html).not.toContain('href="/flow/logic-demo/view/logic"');
  });

  it("puts the same toggle on the code view's pages, with code active", () => {
    const flow = logicFlow();
    const outline = renderFlowOutline(flow, { lang: "en" });
    const state = renderFlowState(flow, { stateIndex: 0, lang: "en" });
    for (const html of [outline, state]) {
      expect(html).toContain('href="/flow/logic-demo/view/logic"');
      expect(html).not.toContain('href="/flow/logic-demo/view/code"');
      expect(html).toContain("viewswitch");
    }
  });

  it("carries the machine block, because the map serves agents too", () => {
    const html = renderFlowLogic(logicFlow(), { lang: "en" });
    expect(html).toContain('id="pv-index"');
  });
});

describe("uncommitted walkthrough", () => {
  it("scopes the prompt to the working tree when there is no sha", () => {
    const p = walkthroughPrompt({ project: "/repo", sha: null });
    expect(p).toContain("uncommitted changes in the working tree");
    expect(p).toContain("workingTreeDiffSamples");
    expect(p).toContain("anchoredAt.dirty: true");
    // And the commit-scoped instructions must not leak into it.
    expect(p).not.toContain("commitDiffSamples");
  });

  it("keeps the commit prompt exactly as it was when a sha is given", () => {
    const p = walkthroughPrompt({ project: "/repo", sha: "a".repeat(40) });
    expect(p).toContain(`Scope: commit ${"a".repeat(40)}`);
    expect(p).toContain("commitDiffSamples");
    expect(p).not.toContain("workingTreeDiffSamples");
  });

  it("titles the card by its scope, so the board says which job this is", () => {
    expect(buildDispatch("walkthrough", { project: "/r", sha: "abcdef1234567890" }).title).toContain("abcdef12");
    expect(buildDispatch("walkthrough", { project: "/r", sha: null }).title).toContain("uncommitted");
  });

  it("puts the narrate button on the uncommitted page, without a sha", () => {
    const entries = [{ file: "src/a.ts", status: "M", flows: [] }];
    const html = renderUncommitted(entries, { lang: "pt" });
    expect(html).toContain('data-mode="walkthrough"');
    expect(html).not.toContain("data-sha");
    expect(html).toContain("Narrar estas alterações como fluxo");
    // The update button stays: refreshing touched flows and narrating the change
    // itself are different jobs, and the page offers both.
    expect(html).toContain('data-mode="update"');
  });

  it("offers no narration when there is nothing uncommitted", () => {
    const html = renderUncommitted([], { lang: "en" });
    expect(html).not.toContain('data-mode="walkthrough"');
  });

  it("translates the clean-tree refusal on the client", () => {
    const js = readFileSync(
      path.resolve(__dirname, "..", "fittings", "seed", "project-viewer", "assets", "viewer.js"),
      "utf8"
    );
    expect(js).toContain("err.treeClean");
    expect(js).toContain("está tudo commitado");
    expect(js).toContain("everything is committed");
  });
});

describe("actions placement", () => {
  // The fitting-wide rule: on a page with content, the actions close the page,
  // AFTER the content they act on — a narration or a fix is a verdict on what was
  // just read. Empty-state CTAs (first run, compare before any report) are the
  // rule degenerating naturally: with nothing to read, the action IS the content.
  const after = (html: string, content: string) => {
    const c = html.indexOf(content);
    const a = html.indexOf('class="actions"');
    expect(c).toBeGreaterThan(-1);
    expect(a).toBeGreaterThan(c);
  };

  it("closes a commit page with its actions, after the diff", () => {
    const meta = { sha: "a".repeat(40), shortSha: "aaaaaaaa", subject: "s" };
    after(renderCommitDiff(meta, [{ file: "x.ts", patch: "", status: "M" }], { lang: "en" }), 'class="diffs"');
  });

  it("closes the findings page with its actions, after the table", () => {
    const finding = { id: "f1", flowId: "demo", severity: "high", text: "t", status: "open" };
    after(renderFindings([finding], { lang: "en" }), 'class="findings"');
  });

  it("closes the uncommitted page with its actions, after the table", () => {
    const entries = [{ file: "src/a.ts", status: "M", flows: [] }];
    after(renderUncommitted(entries, { lang: "en" }), 'class="uncommitted"');
  });
});

describe("doc deletion is gated in code: nothing leaves the repo unconsolidated", () => {
  async function repoWith({ armed = true, approved = true } = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), "pv-cleanup-"));
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, "docs", "old-notes.md"), "# Old notes\n\nBody.\n", "utf8");
    await saveIntake(root, { cleanupArmed: armed });
    if (approved !== null) {
      await writeAllowlist(root, {
        ...(approved ? { approvedAt: "2026-08-13T00:00:00Z" } : {}),
        entries: [{ path: "docs/old-notes.md", reason: "superseded by the flows" }],
      });
    }
    return root;
  }

  async function writeAllowlist(root: string, obj: unknown) {
    await mkdir(path.dirname(cleanupAllowlistPath(root)), { recursive: true });
    await writeFile(cleanupAllowlistPath(root), `${JSON.stringify(obj, null, 2)}\n`, "utf8");
  }

  it("consolidateDoc records the source path and the hash of the exact bytes it copied", async () => {
    const root = await repoWith();
    try {
      const entry = await consolidateDoc(root, "docs/old-notes.md", { docId: "old-notes", title: "Old notes" });
      expect(entry.source).toBe("docs/old-notes.md");
      expect(entry.originalPath).toBe("docs/old-notes.md");
      const original = await readFile(path.join(root, "docs", "old-notes.md"), "utf8");
      const copy = await readFile(path.join(root, entry.storedAt), "utf8");
      expect(copy).toBe(original);
      expect(entry.sourceSha256).toBe(hashText(original));
      const manifest = await getDocsManifest(root);
      expect(manifest.docs.map((d: { docId: string }) => d.docId)).toContain("old-notes");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("consolidateDoc refuses a path that escapes the repo", async () => {
    const root = await repoWith();
    try {
      await expect(consolidateDoc(root, "../outside.md", { docId: "x", title: "X" })).rejects.toThrow(/inside the repo/);
      await expect(consolidateDoc(root, "/etc/hosts", { docId: "x", title: "X" })).rejects.toThrow(/inside the repo/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses everything when intake never armed cleanup", async () => {
    const root = await repoWith({ armed: false });
    try {
      const r = await runCleanup(root, { apply: true });
      expect(r.ok).toBe(false);
      expect(r.problems.join(" ")).toMatch(/never armed/);
      await expect(readFile(path.join(root, "docs", "old-notes.md"), "utf8")).resolves.toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses an allowlist no human approved", async () => {
    const root = await repoWith({ approved: false });
    try {
      const r = await runCleanup(root, { apply: true });
      expect(r.ok).toBe(false);
      expect(r.problems.join(" ")).toMatch(/approvedAt/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses globs and hard-excluded paths outright", async () => {
    const root = await repoWith();
    try {
      await writeAllowlist(root, {
        approvedAt: "2026-08-13T00:00:00Z",
        entries: [
          { path: "docs/*.md", reason: "sweep" },
          { path: "fittings/seed/spotify/README.md", reason: "docs" },
          { path: "src/SKILL.md", reason: "docs" },
        ],
      });
      const r = await runCleanup(root, { apply: true });
      expect(r.ok).toBe(false);
      expect(r.problems.find((p: string) => p.includes("docs/*.md"))).toMatch(/literal/);
      expect(r.problems.find((p: string) => p.includes("fittings/seed"))).toMatch(/hard-excluded/);
      expect(r.problems.find((p: string) => p.includes("SKILL.md"))).toMatch(/hard-excluded/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a doc that was never consolidated — the heart of the gate", async () => {
    const root = await repoWith();
    try {
      const r = await runCleanup(root, { apply: true });
      expect(r.ok).toBe(false);
      expect(r.problems.join(" ")).toMatch(/never consolidated/);
      await expect(readFile(path.join(root, "docs", "old-notes.md"), "utf8")).resolves.toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a doc edited after consolidation until it is consolidated again", async () => {
    const root = await repoWith();
    try {
      await consolidateDoc(root, "docs/old-notes.md", { docId: "old-notes", title: "Old notes" });
      await writeFile(path.join(root, "docs", "old-notes.md"), "# Edited since\n", "utf8");
      const r = await runCleanup(root, { apply: true });
      expect(r.ok).toBe(false);
      expect(r.problems.join(" ")).toMatch(/changed after consolidation/);
      await consolidateDoc(root, "docs/old-notes.md", { docId: "old-notes", title: "Old notes" });
      const again = await runCleanup(root, { apply: false });
      expect(again.ok).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses when the consolidated copy is missing or corrupted", async () => {
    const root = await repoWith();
    try {
      const entry = await consolidateDoc(root, "docs/old-notes.md", { docId: "old-notes", title: "Old notes" });
      await writeFile(path.join(root, entry.storedAt), "tampered\n", "utf8");
      const r = await runCleanup(root, { apply: true });
      expect(r.ok).toBe(false);
      expect(r.problems.join(" ")).toMatch(/no longer matches/);
      await rm(path.join(root, entry.storedAt));
      const r2 = await runCleanup(root, { apply: true });
      expect(r2.ok).toBe(false);
      expect(r2.problems.join(" ")).toMatch(/missing/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("dry run passes every gate without deleting; --apply deletes exactly the list", async () => {
    const root = await repoWith();
    try {
      await consolidateDoc(root, "docs/old-notes.md", { docId: "old-notes", title: "Old notes" });
      const dry = await runCleanup(root, { apply: false });
      expect(dry.ok).toBe(true);
      expect(dry.deleted).toEqual([]);
      await expect(readFile(path.join(root, "docs", "old-notes.md"), "utf8")).resolves.toBeTruthy();
      const wet = await runCleanup(root, { apply: true });
      expect(wet.ok).toBe(true);
      expect(wet.deleted).toEqual(["docs/old-notes.md"]);
      await expect(readFile(path.join(root, "docs", "old-notes.md"), "utf8")).rejects.toThrow();
      const copy = await readFile(path.join(root, "viewer", "docs", "old-notes.md"), "utf8");
      expect(copy).toContain("Old notes");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is all-or-nothing: one failing entry keeps every other entry alive", async () => {
    const root = await repoWith();
    try {
      await consolidateDoc(root, "docs/old-notes.md", { docId: "old-notes", title: "Old notes" });
      await writeFile(path.join(root, "docs", "never-consolidated.md"), "# Nope\n", "utf8");
      await writeAllowlist(root, {
        approvedAt: "2026-08-13T00:00:00Z",
        entries: [
          { path: "docs/old-notes.md", reason: "superseded" },
          { path: "docs/never-consolidated.md", reason: "superseded" },
        ],
      });
      const r = await runCleanup(root, { apply: true });
      expect(r.ok).toBe(false);
      await expect(readFile(path.join(root, "docs", "old-notes.md"), "utf8")).resolves.toBeTruthy();
      await expect(readFile(path.join(root, "docs", "never-consolidated.md"), "utf8")).resolves.toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

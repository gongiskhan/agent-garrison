// Attachments are context, not routing signal - and internal duties are not
// human-routable (2026-08-13).
//
// The live failure both halves come from: a user asked, on the web channel,
// "i use garrison mostly as a pwa and keep getting this error. how do i get rid
// of it?" and attached a screenshot. The channel appends the attachment block to
// the message text, the upload filename happened to contain the word "image",
// and deterministicFallbackDispatch's /\b(image|photo|…)\b/ rule matched THE
// FILENAME - the question was routed as duty image, level 2. When the user
// corrected it, the correction was routed as a fresh turn to `probe-question`,
// the Improver's internal ask-relay, which answered with no thread context at
// all.
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — pure .mjs dispatch core
import {
  stripAttachmentLines,
  INTERNAL_DUTIES,
  buildDispatchPrompt,
  deterministicFallbackDispatch,
  parseDispatch,
  parseLevelOverride,
  dispatch
} from "../fittings/seed/orchestrator/lib/dispatch-core.mjs";

// The upload path from the incident, verbatim in shape: the stamp-prefixed name
// the gateway's saveAttachment mints, ending in the user's own filename.
const UPLOAD =
  "/home/ggomes/dev/garrison/compositions/dogfood-dev/.garrison/uploads/1786740935450-fjqmoh-image.png";
const INCIDENT = [
  "i use garrison mostly as a pwa and keep getting this error. how do i get rid of it?",
  "",
  "Attached file:",
  `- ${UPLOAD}`
].join("\n");

const levels = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    description: `level ${i + 1}`,
    cell: { target: "cc-sonnet", effort: "medium" }
  }));

// A model shaped like the live composition: the real work duties plus the two
// INTERNAL ones, which a composition genuinely wires (they need policy cells).
function model() {
  const ids = ["develop", "image", "discuss", "research", "other", "dispatch", "probe-question"];
  const duties: Record<string, { id: string; title: string; description: string; levels: ReturnType<typeof levels> }> = {};
  for (const id of ids) duties[id] = { id, title: id, description: `${id} work`, levels: levels(3) };
  return { duties, selectedDuties: ids };
}

describe("stripAttachmentLines", () => {
  it("replaces the incident's attachment block with a neutral marker", () => {
    const out = stripAttachmentLines(INCIDENT);
    expect(out).toContain("how do i get rid of it?");
    expect(out).toContain("[1 attachment]");
    // The filename is the whole bug: not one character of it may survive.
    expect(out).not.toContain("image.png");
    expect(out).not.toContain("uploads");
    expect(out).not.toMatch(/Attached file/i);
  });

  it("counts a multi-file block and pluralises", () => {
    const out = stripAttachmentLines(
      ["look at these", "", "Attached files:", "- /var/uploads/a-image.png", "- /var/uploads/b-photo.jpg"].join("\n")
    );
    expect(out).toBe("look at these\n\n[2 attachments]");
  });

  it("strips a bare upload path line with no header", () => {
    expect(stripAttachmentLines(`what is this\n/srv/x/uploads/9-video-render.mp4`)).toBe(
      "what is this\n\n[1 attachment]"
    );
  });

  it("strips an inlined header ('Attached file: - /path')", () => {
    expect(stripAttachmentLines(`why?\n\nAttached file: - ${UPLOAD}`)).toBe("why?\n\n[1 attachment]");
  });

  it("is the identity on a message with no attachment lines", () => {
    const plain = "make me an image of a fox in the snow";
    expect(stripAttachmentLines(plain)).toBe(plain);
    expect(stripAttachmentLines("")).toBe("");
    expect(stripAttachmentLines(null)).toBe("");
  });

  it("is idempotent - the marker is not itself an attachment line", () => {
    const once = stripAttachmentLines(INCIDENT);
    expect(stripAttachmentLines(once)).toBe(once);
  });

  it("leaves an attachment-only message as the marker alone", () => {
    expect(stripAttachmentLines(`Attached file:\n- ${UPLOAD}`)).toBe("[1 attachment]");
  });

  it("does not eat an ordinary bullet list further down the message", () => {
    const text = ["Attached file:", `- ${UPLOAD}`, "", "and please also:", "- rename the tab", "- fix the icon"].join("\n");
    const out = stripAttachmentLines(text);
    expect(out).toContain("- rename the tab");
    expect(out).toContain("- fix the icon");
    expect(out).toContain("[1 attachment]");
  });
});

describe("the keyword fallback lane no longer routes on a filename", () => {
  it("the incident message routes to conversation, never image", () => {
    const out = deterministicFallbackDispatch(model(), INCIDENT);
    expect(out.duty).not.toBe("image");
    expect(["other", "discuss"]).toContain(out.duty);
  });

  it("an attached photo-of-error.jpg does not make a question an image request", () => {
    const out = deterministicFallbackDispatch(
      model(),
      `the button is misaligned, why?\n\nAttached file:\n- /var/uploads/12-photo-of-error.jpg`
    );
    expect(out.duty).not.toBe("image");
  });

  it("a message BODY genuinely asking for an image still routes image", () => {
    expect(deterministicFallbackDispatch(model(), "make me an image of a fox in the snow").duty).toBe("image");
    // …including when a reference picture rides along.
    expect(
      deterministicFallbackDispatch(
        model(),
        "draw me an illustration in this style\n\nAttached file:\n- /var/uploads/3-reference.png"
      ).duty
    ).toBe("image");
  });

  it("a level in a filename is not a human 'run at level N' override", () => {
    expect(parseLevelOverride(`have a look\n\nAttached file:\n- /var/uploads/7-run-at-level-3.png`)).toBeNull();
    // The real directive still wins.
    expect(parseLevelOverride("run at level 3")).toBe(3);
  });
});

describe("internal duties are not inference candidates", () => {
  it("names the two, and only the two", () => {
    expect([...INTERNAL_DUTIES].sort()).toEqual(["dispatch", "probe-question"]);
  });

  it("neither reaches the rendered dispatch prompt's candidate list", () => {
    const prompt = buildDispatchPrompt(model(), "what is going on here?");
    const dutyLine = prompt.split("\n").find((l: string) => /^duty .*one of:/.test(l))!;
    expect(dutyLine).toBeTruthy();
    for (const internal of INTERNAL_DUTIES) {
      expect(dutyLine, `${internal} was offered as a candidate`).not.toContain(internal);
    }
    for (const real of ["develop", "image", "discuss", "other"]) expect(dutyLine).toContain(real);
    // Nor as a described duty further down the prompt.
    expect(prompt).not.toContain("probe-question");
  });

  it("a model that picks one is CLAMPED to the default duty, never honored", () => {
    for (const internal of INTERNAL_DUTIES) {
      const parsed = parseDispatch({ duty: internal, level: 1, confidence: "high" }, model())!;
      expect(parsed.duty, internal).toBe("other");
    }
  });

  it("the deterministic fallback never returns one, even when the message names it", () => {
    const out = deterministicFallbackDispatch(model(), "run the probe-question dispatch please");
    expect(INTERNAL_DUTIES).not.toContain(out.duty);
  });

  it("end to end: a dispatch call answering probe-question lands on a real duty", async () => {
    const out = await dispatch(model(), "what?!? no! I was asking a question!", {
      call: async () => ({ ok: true, structured: { duty: "probe-question", level: 1, confidence: "high" } }),
      evidenceFile: join(mkdtempSync(join(tmpdir(), "dispatch-internal-")), "decisions.jsonl")
    });
    expect(INTERNAL_DUTIES).not.toContain(out.duty);
    expect(out.duty).toBe("other");
  });
});

describe("an explicit pin still reaches an internal duty", () => {
  it("sanitizeRouting accepts probe-question as a duty pin (the exclusion is inference-only)", async () => {
    const saved = { ...process.env };
    process.env.GARRISON_GATEWAY_NO_LISTEN = "1";
    process.env.GARRISON_COMPOSITION_DIR = mkdtempSync(join(tmpdir(), "gw-pin-"));
    try {
      const gw: any = await import(
        new URL("../fittings/seed/http-gateway/scripts/gateway-pty.mjs", import.meta.url).href
      );
      for (const internal of INTERNAL_DUTIES) {
        const { routing } = gw.sanitizeRouting({ duty: internal }, { tiers: [], flows: [], phases: [], flowAliases: {} });
        expect(routing, internal).toMatchObject({ duty: internal });
      }
    } finally {
      process.env = { ...saved };
    }
  });
});

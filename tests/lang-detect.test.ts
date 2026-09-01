// Which language did the user speak? The one question the whole one-language
// fix rests on.
//
// The corpus runs against BOTH copies of lang.mjs in the same table, so a copy
// that drifts fails here as well as in companion-lockstep - this one says which
// PHRASE broke, which is the useful half when you are staring at a diff.
//
// The two named traps are the reported bug and its mirror image. Under the old
// first-match heuristic in tts.mjs, "Comprar comando para a televisão" scored
// English (no accents, and `comprar` was not in its list) while "Buy a remote"
// scored Portuguese (English "a" was in it). Both are pinned forever.

import { describe, expect, it } from "vitest";
import { detectLanguage as fromCapture, pickLanguage, t } from "../fittings/seed/capture-service/lib/lang.mjs";
import { detectLanguage as fromKanban } from "../fittings/seed/kanban-loop/lib/lang.mjs";
import { detectLanguage as fromOmi } from "../fittings/seed/omi-channel/lib/lang.mjs";

const COPIES: Array<[string, (t: string) => string | null]> = [
  ["capture-service", fromCapture],
  ["kanban-loop", fromKanban],
  ["omi-channel", fromOmi]
];

const CORPUS: Array<[string, "pt" | "en" | null]> = [
  // The reported bug, verbatim off the user's own card.
  ["Comprar comando para a televisão", "pt"],
  ["Comprar comando", "pt"],
  // The mirror-image trap: English "a" must not score Portuguese.
  ["Buy a remote", "en"],
  ["Buy a remote for the TV", "en"],
  // A Portuguese sentence carrying an English product name stays Portuguese.
  ["Comprar um adaptador HDMI para a televisão", "pt"],
  // ...and an English sentence carrying one Portuguese word stays English.
  ["Buy a remote for the TV amanha", "en"],
  ["Vamos comer morangos com limão mais logo", "pt"],
  ["Criei a tarefa", "pt"],
  ["amanha de manha", "pt"],
  ["Não te esqueças de regar as plantas", "pt"],
  ["Tenho de pagar o IMI", "pt"],
  ["Marca uma reunião com o João para quinta", "pt"],
  ["Card created", "en"],
  ["Remind me to call the plumber tomorrow", "en"],
  ["Let's talk about the deployment", "en"],
  ["I need to send that email", "en"],
  // A single accent decides a sentence with nothing else to go on.
  ["amanhã", "pt"],
  ["limão", "pt"],
  // No evidence at all. NULL is the honest answer, and it is what makes a
  // remembered language and a configured default worth having.
  ["ok", null],
  ["Zeca", null],
  ["9ZZZ", null],
  ["", null],
  ["   ", null],
  ["7Q2M", null],
  ["Netflix", null]
];

describe("detectLanguage", () => {
  for (const [copy, detect] of COPIES) {
    describe(copy, () => {
      for (const [phrase, want] of CORPUS) {
        it(`${JSON.stringify(phrase)} -> ${want}`, () => {
          expect(detect(phrase)).toBe(want);
        });
      }
    });
  }

  it("never throws on the shapes a transcriber really produces", () => {
    for (const junk of [null, undefined, 123, {}, [], "...", "—", "\n\n"]) {
      expect(() => fromCapture(junk as unknown as string)).not.toThrow();
    }
  });
});

describe("pickLanguage", () => {
  it("honours explicit over everything, then remembered, then the text", () => {
    expect(pickLanguage({ explicit: "en", remembered: "pt", sample: "Criei a tarefa" })).toBe("en");
    expect(pickLanguage({ remembered: "en", sample: "Criei a tarefa" })).toBe("en");
    expect(pickLanguage({ sample: "Criei a tarefa" })).toBe("pt");
  });

  it("falls back rather than guessing when the sample says nothing", () => {
    expect(pickLanguage({ sample: "ok", fallback: "en" })).toBe("en");
    expect(pickLanguage({})).toBe("pt");
    // "auto" is what the config carries when the user has not chosen; it must
    // not be mistaken for a language.
    expect(pickLanguage({ explicit: "auto", sample: "Criei a tarefa" })).toBe("pt");
  });
});

describe("the wake message catalog", () => {
  it("renders both languages with the slots filled", () => {
    expect(t("card.started", { title: "pagar o IMI", ref: "7Q2M" }, "pt")).toBe(
      'Comecei "pagar o IMI" (cartão 7Q2M)'
    );
    expect(t("card.started", { title: "pay the bill", ref: "7Q2M" }, "en")).toBe(
      'Started "pay the bill" (card 7Q2M)'
    );
  });

  it("never throws, whatever is missing", () => {
    // A missing key degrades to the key itself, an unknown language to English,
    // a missing slot to nothing - all of which beat taking out the dispatch
    // that produced the confirmation.
    expect(t("no.such.key", {}, "pt")).toBe("no.such.key");
    expect(t("wake.no_answer", {}, "de")).toBe(t("wake.no_answer", {}, "en"));
    expect(() => t("card.no_match", {}, "pt")).not.toThrow();
    expect(t("card.no_match", {}, "pt")).not.toContain("{ref}");
  });
});

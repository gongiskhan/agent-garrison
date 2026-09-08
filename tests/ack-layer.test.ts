// Acknowledgement layer — the spoken-confirmation class.
//
// The load-bearing test here is "never optimistic" (acceptance criterion 3): an
// ack that announces something which then failed destroys trust in the whole
// layer, so the guarantee has to be structural and pinned, not a convention.

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// @ts-ignore — pure .mjs
import {
  ACK_LANGUAGES,
  DEFAULT_TEMPLATES,
  PT_TEMPLATES,
  TEMPLATES_BY_LANG,
  ackFromOriginEvent,
  ackLanguageFor,
  loadTemplateSets,
  assertSpeakable,
  echoFingerprint,
  isAckableEventKind,
  loadTemplates,
  renderAck,
  validateTemplate
} from "../fittings/seed/kanban-loop/lib/ack.mjs";

const card = (over: Record<string, unknown> = {}) => ({
  id: "01KZK1H0MX6VS239K7068GE1AY",
  title: "follow up with the lawyer",
  originChannel: { channel: "omi", threadId: "omi-reports" },
  ...over
});

describe("ack — never optimistic (acceptance criterion 3)", () => {
  // The whole point: only kinds that routeOriginEvent emits AFTER saveCardCAS has
  // confirmed the write may become an ack. A mid-flight kind must produce nothing,
  // because at that moment the outcome is genuinely unknown.
  it("refuses every event kind whose outcome is not yet settled", () => {
    for (const kind of ["steering", "needs-input", "duty-summary", "schedule-due", "dispatched", "claimed"]) {
      expect(isAckableEventKind(kind)).toBe(false);
      expect(ackFromOriginEvent({ kind }, card())).toBeNull();
    }
  });

  it("a failing outcome yields a failure ack and never a success one", () => {
    const failed = ackFromOriginEvent({ kind: "failed" }, card()) as any;
    expect(failed.kind).toBe("failed");
    expect(failed.severity).toBe("error");
    expect(failed.text).toBe("Could not finish follow up with the lawyer.");
    // The sentence must not be able to read as success under any rendering.
    expect(failed.text).not.toMatch(/created|finished|sent|done/i);
  });

  // The specific regression this guards: an integration call that fails after the
  // card was created must not leave a spoken "sent" behind. Injecting a failing
  // integration means the terminal kind is `failed`, and the ONLY ack for that
  // card's terminal edge is the failure one.
  it("a failing integration emits no success ack", () => {
    const emitted = [{ kind: "created" }, { kind: "failed" }]
      .map((e) => ackFromOriginEvent(e, card()))
      .filter(Boolean) as any[];
    const terminal = emitted.filter((a) => ["completed", "failed"].includes(a.kind));
    expect(terminal).toHaveLength(1);
    expect(terminal[0].kind).toBe("failed");
    expect(emitted.some((a) => a.kind === "completed")).toBe(false);
  });

  it("blocked is an error the operator hears, not a silent stall", () => {
    const a = ackFromOriginEvent({ kind: "blocked" }, card()) as any;
    expect(a.kind).toBe("failed");
    expect(a.severity).toBe("error");
  });
});

describe("ack — every utterance names its referent", () => {
  it("each shipped template interpolates at least one slot", () => {
    for (const [id, tpl] of Object.entries(DEFAULT_TEMPLATES)) {
      expect(validateTemplate(id, tpl), `template ${id}`).toEqual([]);
    }
  });

  it("rejects a template that would render the same sentence every time", () => {
    expect(validateTemplate("bad", { kind: "created", severity: "info", slots: [], text: "Done." }))
      .toContain("bad: template names no referent (every ack must say what it is about)");
  });

  it("a card with no title produces no ack rather than an anonymous one", () => {
    expect(ackFromOriginEvent({ kind: "created" }, card({ title: "  " }))).toBeNull();
  });

  it("renders the referent into the sentence", () => {
    expect(renderAck("card.created", { subject: "follow up with the lawyer" }))
      .toBe("Created a task, follow up with the lawyer.");
    expect(renderAck("integration.failed", { target: "Slack" })).toBe("Could not connect to Slack.");
  });

  it("refuses to render with a missing slot instead of speaking a gap", () => {
    expect(() => renderAck("card.created", {})).toThrow(/missing slot/);
  });
});

describe("ack — spoken into a live microphone", () => {
  // The operator wears an always-on pendant, so an ack containing the wake word
  // opens a capture window the moment it is spoken and turns the next thing they
  // say into a command they never issued. Slots are free text from the operator's
  // own request, so the check must run on the FINISHED sentence.
  it("refuses a rendered sentence containing the wake word", () => {
    expect(() => assertSpeakable("Created a task, send Zeca the invoice.")).toThrow(/wake word/);
    expect(() => renderAck("card.created", { subject: "send Zeca the invoice" })).toThrow(/wake word/);
  });

  // omi-channel's gate matches the token ANYWHERE in a segment, so a sentence
  // carrying the name mid-clause really would open a capture window if spoken.
  // That makes this the only thing between a voice sink and the pendant.
  it("refuses the name mid-sentence, not just at the front", () => {
    expect(() => assertSpeakable("Finished it, tell Zeca to run card 4F2A.")).toThrow(/wake word/);
  });

  // The operative was renamed once already. If this guard honoured a stored
  // wake_variants made up entirely of retired spellings it would police the
  // WRONG word and pass an ack carrying the live one - the single way this check
  // can fail open - so such a value is ignored.
  it("guards the current name when the config still holds the retired one", () => {
    const env = { GARRISON_CAPTURESERVICE_WAKE_VARIANTS: "gary,garry,gerry,géri" };
    expect(() => assertSpeakable("Created a task, send Zeca the invoice.", env)).toThrow(/wake word/);
    expect(assertSpeakable("Created a task, send Gary the invoice.", env)).toContain("Gary");
  });

  it("allows the same sentence without the wake word", () => {
    expect(assertSpeakable("Created a task, send the invoice.")).toBe("Created a task, send the invoice.");
  });

  it("a wake collision skips the ack without killing the card event", () => {
    const a = ackFromOriginEvent({ kind: "created" }, card({ title: "ask Zeca about the invoice" })) as any;
    expect(a.skipped).toBe("wake-collision");
    expect(a.text).toBeUndefined();
  });

  it("carries an echo fingerprint that survives transcription drift", () => {
    const a = ackFromOriginEvent({ kind: "created" }, card()) as any;
    expect(a.echo).toMatch(/^[0-9a-f]{16}$/);
    // The transcriber returns the sentence with different casing, accents and
    // punctuation; the fingerprint has to match anyway or echo suppression fails
    // exactly when it is needed.
    expect(echoFingerprint("Created a task, follow up with the lawyer."))
      .toBe(echoFingerprint("created a TASK  follow up with the lawyer"));
  });

  it("different sentences do not collide", () => {
    expect(echoFingerprint("Sent the message to Slack.")).not.toBe(echoFingerprint("Created a task, x."));
  });
});

describe("ack — the payload the sinks consume", () => {
  it("carries what a speech sink and a future haptic companion both need", () => {
    const a = ackFromOriginEvent({ kind: "created", idempotencyKey: "k1" }, card()) as any;
    expect(a).toMatchObject({
      kind: "created",
      severity: "info",
      templateId: "card.created",
      referent: "follow up with the lawyer",
      cardId: "01KZK1H0MX6VS239K7068GE1AY",
      sourceChannel: "omi",
      idempotencyKey: "k1"
    });
    expect(a.slots).toEqual({ subject: "follow up with the lawyer" });
    expect(Date.parse(a.emittedAt)).not.toBeNaN();
  });

  it("is stable per card+kind so two sinks can dedupe the same ack", () => {
    const a = ackFromOriginEvent({ kind: "created" }, card()) as any;
    const b = ackFromOriginEvent({ kind: "created" }, card()) as any;
    expect(a.id).toBe(b.id);
    expect(ackFromOriginEvent({ kind: "failed" }, card()).id).not.toBe(a.id);
  });
});

describe("ack — the editable registry", () => {
  it("falls back to the committed defaults when there is no overlay", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "ack-none-"));
    expect(loadTemplates({ env: { GARRISON_HOME: home } })).toEqual(DEFAULT_TEMPLATES);
    rmSync(home, { recursive: true, force: true });
  });

  it("accepts a valid operator edit", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "ack-ok-"));
    mkdirSync(path.join(home, "kanban-loop"), { recursive: true });
    writeFileSync(
      path.join(home, "kanban-loop", "ack-templates.json"),
      JSON.stringify({ "card.created": { kind: "created", severity: "info", slots: ["subject"], text: "Nova tarefa, {subject}." } })
    );
    const t = loadTemplates({ env: { GARRISON_HOME: home } }) as any;
    expect(t["card.created"].text).toBe("Nova tarefa, {subject}.");
    rmSync(home, { recursive: true, force: true });
  });

  // Half an applied edit is a registry nobody can reason about, and the operator
  // would hear a mix of old and new wording with no way to tell which took.
  it("refuses an invalid overlay WHOLE rather than merging the good half", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "ack-bad-"));
    mkdirSync(path.join(home, "kanban-loop"), { recursive: true });
    writeFileSync(
      path.join(home, "kanban-loop", "ack-templates.json"),
      JSON.stringify({
        "card.created": { kind: "created", severity: "info", slots: ["subject"], text: "Fine, {subject}." },
        "card.completed": { kind: "completed", severity: "info", slots: [], text: "Done." }
      })
    );
    const t = loadTemplates({ env: { GARRISON_HOME: home }, log: { warn: () => {} } });
    expect(t).toEqual(DEFAULT_TEMPLATES);
    rmSync(home, { recursive: true, force: true });
  });
});

describe("ack — one language per sentence", () => {
  // The reported bug, verbatim: "Task created: Comprar comando para a
  // televisão." The card title is the user's own words (the classifier keeps
  // their language), so an English frame around it is half a sentence in each.
  it("speaks a Portuguese card entirely in Portuguese", () => {
    const a = ackFromOriginEvent({ kind: "created" }, card({ title: "Comprar comando para a televisão" })) as any;
    expect(a.lang).toBe("pt");
    expect(a.text).toBe("Criei uma tarefa: Comprar comando para a televisão.");
    expect(a.text).not.toContain("Created");
  });

  // The regression pin that matters most: an English card must still produce
  // the EXACT sentence it produced before any of this existed.
  it("leaves an English card byte-for-byte as it was", () => {
    const a = ackFromOriginEvent({ kind: "created" }, card({ title: "follow up with the lawyer" })) as any;
    expect(a.text).toBe("Created a task, follow up with the lawyer.");
    expect(a.lang).toBe("en");
  });

  it("prefers card.lang over reading the title, and an explicit lang over both", () => {
    // The wake bus decided from the whole spoken command, which is far better
    // evidence than three words of title.
    expect(ackLanguageFor({ title: "Buy a remote", lang: "pt" })).toBe("pt");
    expect(ackLanguageFor({ title: "Buy a remote", lang: "pt" }, { lang: "en" })).toBe("en");
    const a = ackFromOriginEvent({ kind: "created" }, card({ title: "Buy a remote", lang: "pt" })) as any;
    expect(a.text).toBe("Criei uma tarefa: Buy a remote.");
  });

  it("falls back to the configured language when the title says nothing", () => {
    // "9ZZZ" carries no evidence either way; guessing is what a default is for.
    expect(ackLanguageFor({ title: "9ZZZ" }, { env: { GARRISON_KANBANLOOP_ACK_LANGUAGE: "pt" } })).toBe("pt");
    expect(ackLanguageFor({ title: "9ZZZ" }, { env: {} })).toBe("en");
  });

  it("skips selection entirely when a caller pins a flat registry", () => {
    const a = ackFromOriginEvent({ kind: "created" }, card({ title: "Comprar pão" }), {
      templates: DEFAULT_TEMPLATES
    }) as any;
    expect(a.text).toBe("Created a task, Comprar pão.");
    expect(a.lang).toBeNull();
  });

  // The thing that rots: someone adds a template to one language only, and the
  // other silently falls back to a frame in the wrong language.
  it("keeps template ids and slots identical across languages", () => {
    for (const lang of ACK_LANGUAGES) {
      expect(Object.keys(TEMPLATES_BY_LANG[lang]).sort()).toEqual(Object.keys(DEFAULT_TEMPLATES).sort());
    }
    for (const [id, en] of Object.entries(DEFAULT_TEMPLATES) as any) {
      const pt = (PT_TEMPLATES as any)[id];
      expect([id, pt.kind, pt.severity, [...pt.slots].sort()]).toEqual([id, en.kind, en.severity, [...en.slots].sort()]);
    }
  });

  it("validates every template in every language", () => {
    for (const lang of ACK_LANGUAGES) {
      for (const [id, tpl] of Object.entries(TEMPLATES_BY_LANG[lang])) {
        expect([lang, id, validateTemplate(id, tpl)]).toEqual([lang, id, []]);
      }
    }
  });
});

describe("ack — the registry overlay across languages", () => {
  const withOverlay = (body: unknown, run: (home: string) => void) => {
    const home = mkdtempSync(path.join(os.tmpdir(), "ack-lang-"));
    mkdirSync(path.join(home, "kanban-loop"), { recursive: true });
    writeFileSync(path.join(home, "kanban-loop", "ack-templates.json"), JSON.stringify(body));
    try {
      run(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  };

  // A flat overlay predates languages entirely. Applying it to English only
  // would silently change an operator's acks the day Portuguese starts being
  // picked - the one outcome nobody could debug.
  it("applies a legacy flat overlay to every language", () => {
    withOverlay(
      { "card.created": { kind: "created", severity: "info", slots: ["subject"], text: "Nova tarefa, {subject}." } },
      (home) => {
        const sets = loadTemplateSets({ env: { GARRISON_HOME: home } }) as any;
        expect(sets.en["card.created"].text).toBe("Nova tarefa, {subject}.");
        expect(sets.pt["card.created"].text).toBe("Nova tarefa, {subject}.");
      }
    );
  });

  it("applies a nested overlay per language", () => {
    withOverlay(
      { pt: { "card.created": { kind: "created", severity: "info", slots: ["subject"], text: "Apontado, {subject}." } } },
      (home) => {
        const sets = loadTemplateSets({ env: { GARRISON_HOME: home } }) as any;
        expect(sets.pt["card.created"].text).toBe("Apontado, {subject}.");
        expect(sets.en["card.created"].text).toBe(DEFAULT_TEMPLATES["card.created"].text);
      }
    );
  });

  it("refuses the whole overlay when ANY language fails validation", () => {
    withOverlay(
      {
        en: { "card.created": { kind: "created", severity: "info", slots: ["subject"], text: "Fine, {subject}." } },
        pt: { "card.completed": { kind: "completed", severity: "info", slots: [], text: "Feito." } }
      },
      (home) => {
        const sets = loadTemplateSets({ env: { GARRISON_HOME: home }, log: { warn: () => {} } }) as any;
        expect(sets.en).toEqual(DEFAULT_TEMPLATES);
        expect(sets.pt).toEqual(PT_TEMPLATES);
      }
    );
  });

  // Previously this only blew up at RENDER time, in the operator's ear, once
  // per ack forever. A frame carrying the wake word speaks the pendant into a
  // capture window every single time.
  it("refuses a template whose FRAME carries the wake word, at load", () => {
    withOverlay(
      { pt: { "card.created": { kind: "created", severity: "info", slots: ["subject"], text: "Zeca criou, {subject}." } } },
      (home) => {
        const sets = loadTemplateSets({ env: { GARRISON_HOME: home }, log: { warn: () => {} } }) as any;
        expect(sets.pt).toEqual(PT_TEMPLATES);
      }
    );
  });
});

// @ts-ignore — pure .mjs
import { EchoGuard, normalizeTokens } from "../fittings/seed/capture-service/lib/echo-guard.mjs";

describe("echo guard — Garrison does not hear itself", () => {
  const spoken = "Created a task, follow up with the lawyer.";

  it("suppresses the ack coming back through the pendant, fragmented and re-cased", () => {
    const g = new EchoGuard({});
    g.register({ text: spoken });
    // Omi returns one sentence as several fragments with drifted punctuation.
    expect(g.shouldSuppress("created a task")).toBe(true);
    expect(g.shouldSuppress("follow up with the lawyer")).toBe(true);
    expect(g.shouldSuppress("Created a task follow up with the lawyer")).toBe(true);
  });

  it("does not touch the operator's real speech", () => {
    const g = new EchoGuard({});
    g.register({ text: spoken });
    expect(g.shouldSuppress("did you call the lawyer about the invoice")).toBe(false);
    expect(g.shouldSuppress("cria uma tarefa para comprar peixe")).toBe(false);
  });

  // Over-suppression eats the operator's words irrecoverably; a missed echo costs
  // one deletable card. So short fragments are always let through.
  it("never swallows a short utterance even when its words appear in the ack", () => {
    const g = new EchoGuard({});
    g.register({ text: spoken });
    expect(g.shouldSuppress("created")).toBe(false);
    expect(g.shouldSuppress("the lawyer")).toBe(false);
  });

  it("stops suppressing once the window has passed", () => {
    let t = 1_000_000;
    const g = new EchoGuard({ ttlMs: 30_000, now: () => t });
    g.register({ text: spoken });
    expect(g.shouldSuppress("created a task")).toBe(true);
    t += 31_000;
    expect(g.shouldSuppress("created a task")).toBe(false);
  });

  it("suppresses nothing when nothing has been spoken", () => {
    expect(new EchoGuard({}).shouldSuppress("created a task")).toBe(false);
  });

  it("normalises accents and punctuation the transcriber will not reproduce", () => {
    expect(normalizeTokens("Criei uma tarefa, ligar ao banco.")).toEqual(
      ["criei", "uma", "tarefa", "ligar", "ao", "banco"]
    );
  });
});

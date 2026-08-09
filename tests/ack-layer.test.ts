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
  DEFAULT_TEMPLATES,
  ackFromOriginEvent,
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
    expect(() => assertSpeakable("Created a task, send Gary the invoice.")).toThrow(/wake word/);
    expect(() => renderAck("card.created", { subject: "send Gary the invoice" })).toThrow(/wake word/);
  });

  it("allows the same sentence without the wake word", () => {
    expect(assertSpeakable("Created a task, send the invoice.")).toBe("Created a task, send the invoice.");
  });

  it("a wake collision skips the ack without killing the card event", () => {
    const a = ackFromOriginEvent({ kind: "created" }, card({ title: "ask Gary about the invoice" })) as any;
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

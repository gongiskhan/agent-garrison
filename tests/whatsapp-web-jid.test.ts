import { describe, expect, it } from "vitest";
import { assertValidJid, isValidJid } from "../fittings/seed/whatsapp-web/lib/jid.mjs";

// Rule 1 of the whatsapp-web brief: send_text must only ever accept an exact,
// already-confirmed WhatsApp JID. This is the single choke point that rule
// hangs off, so it gets its own focused test.
describe("whatsapp-web jid validation", () => {
  it("accepts an individual chat jid", () => {
    expect(isValidJid("351912345678@s.whatsapp.net")).toBe(true);
  });

  it("accepts a group chat jid", () => {
    expect(isValidJid("120363012345678901@g.us")).toBe(true);
  });

  it("rejects a bare name", () => {
    expect(isValidJid("Maria")).toBe(false);
  });

  it("rejects a bare phone number with no jid suffix", () => {
    expect(isValidJid("351912345678")).toBe(false);
  });

  it("rejects a jid with a wrong domain", () => {
    expect(isValidJid("351912345678@example.com")).toBe(false);
  });

  it("rejects a jid with non-numeric digits", () => {
    expect(isValidJid("abc123@s.whatsapp.net")).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(isValidJid(undefined)).toBe(false);
    expect(isValidJid(null)).toBe(false);
    expect(isValidJid(12345)).toBe(false);
    expect(isValidJid({})).toBe(false);
  });

  it("assertValidJid throws a descriptive error for an invalid jid", () => {
    expect(() => assertValidJid("Maria")).toThrow(/resolve_contact/);
  });

  it("assertValidJid does not throw for a valid jid", () => {
    expect(() => assertValidJid("351912345678@s.whatsapp.net")).not.toThrow();
  });
});

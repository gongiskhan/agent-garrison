import { describe, expect, it } from "vitest";
import { ContactIndex } from "../fittings/seed/whatsapp-web/lib/contacts.mjs";

describe("whatsapp-web ContactIndex", () => {
  it("resolve() returns a LIST, never a single guess", () => {
    const idx = new ContactIndex();
    idx.upsert("351912345678@s.whatsapp.net", "Maria Silva");
    const result = idx.resolve("Maria");
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([{ name: "Maria Silva", jid: "351912345678@s.whatsapp.net" }]);
  });

  it("ranks exact match, then prefix match, then substring match", () => {
    const idx = new ContactIndex();
    idx.upsert("1@s.whatsapp.net", "Maria");
    idx.upsert("2@s.whatsapp.net", "Maria Silva");
    idx.upsert("3@s.whatsapp.net", "Ana Maria");
    const result = idx.resolve("maria");
    expect(result.map((c) => c.name)).toEqual(["Maria", "Maria Silva", "Ana Maria"]);
  });

  it("is case-insensitive", () => {
    const idx = new ContactIndex();
    idx.upsert("1@s.whatsapp.net", "Maria Silva");
    expect(idx.resolve("MARIA")).toHaveLength(1);
  });

  it("returns an empty array for no match", () => {
    const idx = new ContactIndex();
    idx.upsert("1@s.whatsapp.net", "Maria Silva");
    expect(idx.resolve("Zzz")).toEqual([]);
  });

  it("returns an empty array for an empty query", () => {
    const idx = new ContactIndex();
    idx.upsert("1@s.whatsapp.net", "Maria Silva");
    expect(idx.resolve("")).toEqual([]);
    expect(idx.resolve(undefined)).toEqual([]);
  });

  it("upsert overwrites the name for a jid seen again with a different name", () => {
    const idx = new ContactIndex();
    idx.upsert("1@s.whatsapp.net", "Maria");
    idx.upsert("1@s.whatsapp.net", "Maria Silva (Work)");
    expect(idx.resolve("Maria")).toEqual([{ name: "Maria Silva (Work)", jid: "1@s.whatsapp.net" }]);
  });

  it("respects the limit parameter", () => {
    const idx = new ContactIndex();
    for (let i = 0; i < 30; i++) idx.upsert(`${i}@s.whatsapp.net`, `Maria ${i}`);
    expect(idx.resolve("Maria", 5)).toHaveLength(5);
  });

  it("ignores upsert calls with a missing jid or name", () => {
    const idx = new ContactIndex();
    idx.upsert(undefined, "Maria");
    idx.upsert("1@s.whatsapp.net", undefined);
    expect(idx.size).toBe(0);
  });
});

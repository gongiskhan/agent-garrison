import { describe, expect, it } from "vitest";
import { aliasRegex, applyAliases } from "../fittings/seed/capture-service/lib/pronunciation-aliases.mjs";

describe("pronunciation aliases", () => {
  it("rewrites every known misheard variant to the canonical spelling", () => {
    const aliasMap = { EKOA: ["eco a", "eco-a", "ecoa", "e coa"] };
    expect(applyAliases("manda uma mensagem para a eco a", aliasMap)).toBe("manda uma mensagem para a EKOA");
    expect(applyAliases("fala com a Eco-A sobre o projeto", aliasMap)).toBe("fala com a EKOA sobre o projeto");
    expect(applyAliases("ecoa disse que sim", aliasMap)).toBe("EKOA disse que sim");
    expect(applyAliases("manda para a e coa", aliasMap)).toBe("manda para a EKOA");
  });

  it("only matches whole tokens - never a substring inside an unrelated word", () => {
    const aliasMap = { EKOA: ["ecoa"] };
    expect(applyAliases("a decoação ficou boa", aliasMap)).toBe("a decoação ficou boa");
  });

  it("is a no-op on empty text, an absent map, or text with no variant present", () => {
    expect(applyAliases("", { EKOA: ["ecoa"] })).toBe("");
    expect(applyAliases("hello", null)).toBe("hello");
    expect(applyAliases("nothing to fix here", { EKOA: ["ecoa"] })).toBe("nothing to fix here");
  });

  it("aliasRegex returns null for an empty variant list", () => {
    expect(aliasRegex([])).toBeNull();
    expect(aliasRegex(undefined)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { garrisonRoutePath, parseMessageBody } from "@/lib/message-body";

describe("parseMessageBody", () => {
  it("returns the original string as a single text segment when no URLs are present", () => {
    expect(parseMessageBody("hello world")).toEqual([
      { type: "text", value: "hello world" }
    ]);
  });

  it("recognizes a garrison:// URL and pulls the fitting id and rest", () => {
    const segments = parseMessageBody(
      "captured in garrison://documents/abc123"
    );
    expect(segments).toEqual([
      { type: "text", value: "captured in " },
      {
        type: "garrison",
        value: "garrison://documents/abc123",
        fittingId: "documents",
        rest: "abc123"
      }
    ]);
  });

  it("recognizes a multi-segment garrison rest path", () => {
    const segments = parseMessageBody("see garrison://documents/abc/edit now");
    expect(segments).toEqual([
      { type: "text", value: "see " },
      {
        type: "garrison",
        value: "garrison://documents/abc/edit",
        fittingId: "documents",
        rest: "abc/edit"
      },
      { type: "text", value: " now" }
    ]);
  });

  it("strips a single trailing sentence terminator from URLs", () => {
    const segments = parseMessageBody("link: garrison://documents/abc.");
    expect(segments).toEqual([
      { type: "text", value: "link: " },
      {
        type: "garrison",
        value: "garrison://documents/abc",
        fittingId: "documents",
        rest: "abc"
      },
      { type: "text", value: "." }
    ]);
  });

  it("treats https:// URLs as external links", () => {
    const segments = parseMessageBody("see https://example.com/x for context");
    expect(segments).toEqual([
      { type: "text", value: "see " },
      {
        type: "external",
        value: "https://example.com/x",
        href: "https://example.com/x"
      },
      { type: "text", value: " for context" }
    ]);
  });

  it("handles a mix of garrison and external URLs in one body", () => {
    const segments = parseMessageBody(
      "doc: garrison://documents/abc and src: https://example.com/y"
    );
    expect(segments.map((seg) => seg.type)).toEqual([
      "text",
      "garrison",
      "text",
      "external"
    ]);
  });

  it("preserves the bare host when garrison:// is missing a path", () => {
    const segments = parseMessageBody("oops garrison://documents");
    expect(segments).toEqual([
      { type: "text", value: "oops " },
      {
        type: "garrison",
        value: "garrison://documents",
        fittingId: "documents",
        rest: ""
      }
    ]);
  });

  it("returns an empty list for an empty body", () => {
    expect(parseMessageBody("")).toEqual([]);
  });
});

describe("garrisonRoutePath", () => {
  it("maps the bare host to /fitting/<id>", () => {
    expect(garrisonRoutePath("documents", "")).toBe("/fitting/documents");
  });

  it("appends the rest under /fitting/<id>", () => {
    expect(garrisonRoutePath("documents", "abc/edit")).toBe(
      "/fitting/documents/abc/edit"
    );
  });
});

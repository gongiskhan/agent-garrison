// M7 — Web context is UI/thread metadata, never hidden chat input.
//
// A fitting may hand the browser an opaque `context` blob for thread identity,
// briefs, and other visible UI. The Web server must not forward that value to the
// gateway, where it would become an invisible user-message prefix. These tests
// pin both sides of that boundary without a browser:
//
//   1. server.mjs buildGatewayChatBody always omits context and mode, preserving
//      the exact admitted message.
//   2. ClaudeChat — accepts the new optional `context`/`mode` props without
//      changing render behavior, and buildSendMeta keeps them available to a
//      transport that deliberately uses them as metadata.
//   3. Doc render — assistant markdown links to produced docs/artifacts render
//      as real links (garrison:// cross-fitting links translated; http links
//      open in a new tab), never raw.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMarkdown } from "@/lib/markdown";
// @ts-ignore — pure .mjs server
import { buildGatewayChatBody } from "../packages/talk/src/server.mjs";
import { ClaudeChat, buildSendMeta } from "../packages/claude-chat/src/index";

// A context-unaware transport that records exactly how sendMessage was invoked,
// so we can assert the channel calls it single-arg when no context/mode exist.
function recordingTransport() {
  const calls: { args: unknown[] }[] = [];
  return {
    calls,
    transport: {
      base: "/api",
      connect: () => () => {},
      sendMessage: (...args: unknown[]) => {
        calls.push({ args });
        return Promise.resolve();
      },
      sendKey: async () => {},
      setMode: async (m: any) => ({ mode: m, reached: false }),
      interrupt: async () => {},
      fetchCommands: async () => [],
    },
  };
}

describe("web-channel exact-message contract — server", () => {
  it("absent context → EXACTLY { message, channel: 'web' }", () => {
    expect(buildGatewayChatBody({ message: "hello" })).toEqual({
      message: "hello",
      channel: "web",
    });
  });

  it("omits opaque context even when a caller supplies it", () => {
    const context = { kind: "card", id: 42, nested: { board: "kanban" } };
    expect(buildGatewayChatBody({ message: "hi", context })).toEqual({
      message: "hi",
      channel: "web",
    });
  });

  it("does not forward context or the retired mode field", () => {
    expect(buildGatewayChatBody({ message: "go", context: [1, 2, 3], mode: "james" })).toEqual({
      message: "go",
      channel: "web",
    });
  });

  it("keeps absent and empty metadata out of the body", () => {
    expect(buildGatewayChatBody({ message: "hi", context: null, mode: "" })).toEqual({
      message: "hi",
      channel: "web",
    });
    expect(buildGatewayChatBody({ message: "hi", mode: "   " })).toEqual({
      message: "hi",
      channel: "web",
    });
  });

  it("forwards a routing classification hint when present (the Discuss no-thinking pin)", () => {
    expect(
      buildGatewayChatBody({ message: "hi", classification: { taskType: "other", tier: "T0-trivial" } })
    ).toEqual({
      message: "hi",
      channel: "web",
      classification: { taskType: "other", tier: "T0-trivial" },
    });
    // Absent hint stays backward-compatible (no classification key).
    expect(buildGatewayChatBody({ message: "hi" })).toEqual({ message: "hi", channel: "web" });
  });

  it("channel is always pinned to 'web' and context cannot smuggle fields", () => {
    const body = buildGatewayChatBody({ message: "hi", context: { channel: "evil" } });
    expect(body).toEqual({ message: "hi", channel: "web" });
  });
});

describe("ClaudeChat — context remains available as UI metadata", () => {
  it("labels the explicit shared-PTY console separately from generated threads", () => {
    const source = readFileSync(
      path.join(process.cwd(), "packages/talk/ui/app.tsx"),
      "utf8"
    );
    // The conversations rename (C6) moved both labels: the raw PTY surface is the
    // shared CONVERSATION console, and a thread is a conversation, not a session.
    expect(source).toContain('title="Shared conversation console"');
    expect(source).toContain('title="Conversation"');
  });

  it("buildSendMeta returns undefined when both context and mode are absent", () => {
    expect(buildSendMeta(undefined, undefined)).toBeUndefined();
    expect(buildSendMeta(null, undefined)).toBeUndefined();
    expect(buildSendMeta(undefined, "")).toBeUndefined();
    expect(buildSendMeta(null, "   ")).toBeUndefined();
  });

  it("buildSendMeta carries only the present fields", () => {
    expect(buildSendMeta({ a: 1 }, undefined)).toEqual({ context: { a: 1 } });
    expect(buildSendMeta(undefined, "james")).toEqual({ mode: "james" });
    expect(buildSendMeta({ a: 1 }, "  james  ")).toEqual({ context: { a: 1 }, mode: "james" });
  });

  it("the default render is byte-identical with and without the new props", () => {
    const { transport } = recordingTransport();
    const baseline = renderToStaticMarkup(
      createElement(ClaudeChat, { transport: transport as any, title: "Operative" })
    );
    const withCtx = renderToStaticMarkup(
      createElement(ClaudeChat, {
        transport: transport as any,
        title: "Operative",
        context: { card: 1 },
        mode: "james",
      })
    );
    expect(baseline).toContain("Operative");
    // New props are opaque + threaded only at send time, so static markup is
    // unchanged — proving dev-env's existing use of ClaudeChat does not regress.
    expect(withCtx).toBe(baseline);
  });
});

describe("doc render — produced documents render as links, not raw", () => {
  it("translates garrison:// cross-fitting links to /fitting/<id>/<rest>", () => {
    const html = renderMarkdown("See [the brief](garrison://artifact-store/docs/brief.md).") as string;
    expect(html).toContain('href="/fitting/artifact-store/docs/brief.md"');
    expect(html).not.toContain("garrison://");
  });

  it("opens http(s) document links in a new tab (noopener)", () => {
    const html = renderMarkdown("Open [the report](https://example.com/report.md).") as string;
    expect(html).toContain('href="https://example.com/report.md"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("renders a fenced/document block as HTML, never raw markdown", () => {
    const html = renderMarkdown("# Brief\n\nA produced **document**.") as string;
    expect(html).toContain("<h1");
    expect(html).toContain("<strong>document</strong>");
  });

  it("does NOT linkify active-content schemes (javascript:/data:/vbscript:) — drops the href, keeps the text", () => {
    const js = renderMarkdown("Click [me](javascript:alert(1)).") as string;
    expect(js).not.toContain("javascript:");
    expect(js).not.toContain("<a ");      // no anchor emitted for an unsafe scheme
    expect(js).toContain("me");            // link text is preserved

    const data = renderMarkdown("[x](data:text/html;base64,PHNjcmlwdD4=)") as string;
    expect(data).not.toContain("data:text/html");
    expect(data).not.toContain("<a ");

    const vb = renderMarkdown("[y](vbscript:msgbox(1))") as string;
    expect(vb).not.toContain("vbscript:");
  });

  it("escapes the href attribute so a crafted URL cannot break out of it", () => {
    const html = renderMarkdown('[x](https://e.com/a"onmouseover="alert(1))') as string;
    // The raw double-quote-and-handler must not appear unescaped in the markup.
    expect(html).not.toContain('"onmouseover="alert(1)');
  });
});

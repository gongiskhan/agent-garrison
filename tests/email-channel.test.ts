// email-channel seed fitting: pure ingest mapping + the probe as a REAL node
// child process (importing an .mjs module in vitest is not a link check - a
// missing named import arrives as `undefined` instead of throwing; only a
// spawned `node` proves the module graph links).

import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const seedDir = path.join(__dirname, "..", "fittings", "seed", "email-channel");

async function ingestLib() {
  return import(pathToFileURL(path.join(seedDir, "lib", "ingest.mjs")).href);
}

describe("email-channel probe (verify hook)", () => {
  it("links and prints EMAIL-OK as a real node child process", () => {
    const res = spawnSync(process.execPath, [path.join(seedDir, "scripts", "email.mjs"), "--probe"], {
      encoding: "utf8",
      env: { ...process.env, GARRISON_HOME: "/tmp/email-channel-test-home" },
      timeout: 15000
    });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("EMAIL-OK");
  });
});

describe("sender allow-list (fail-closed)", () => {
  it("rejects everything when the list is empty", async () => {
    const { parseSenderList, senderAllowed } = await ingestLib();
    const empty = parseSenderList("");
    expect(senderAllowed("anyone@example.com", empty)).toBe(false);
    expect(senderAllowed("", empty)).toBe(false);
  });

  it("matches case-insensitively and trims entries", async () => {
    const { parseSenderList, senderAllowed } = await ingestLib();
    const set = parseSenderList(" A@B.C , second@example.com ");
    expect(senderAllowed("a@b.c", set)).toBe(true);
    expect(senderAllowed("Second@Example.COM", set)).toBe(true);
    expect(senderAllowed("third@example.com", set)).toBe(false);
  });
});

describe("card payload mapping", () => {
  const detail = {
    id: "msg123",
    msgid: "<abc@mail.example>",
    from: { address: "sender@example.com", name: "A Sender" },
    subject: "Fix the widget",
    text: "Body line one\nBody line two",
    html: [],
    attachments: [
      { id: "A1", filename: "doc.pdf", size: 1024, downloadUrl: "/messages/msg123/attachment/A1" },
      { id: "A2", filename: "video.mov", size: 99 * 1024 * 1024, downloadUrl: "/messages/msg123/attachment/A2" }
    ],
    createdAt: "2026-08-31T10:00:00+00:00"
  };

  it("maps subject to title, body + provenance to description, and dedupe key to origin_id", async () => {
    const { buildCardPayload } = await ingestLib();
    const { payload, oversized } = buildCardPayload(detail, { inboxAddress: "inbox@x.test", targetList: "todo" });
    expect(payload.title).toBe("Fix the widget");
    expect(payload.origin).toBe("email");
    expect(payload.origin_id).toBe("email:msg123");
    expect(payload.targetList).toBe("todo");
    expect(payload.project).toBeUndefined();
    expect(payload.description).toContain("> Body line one");
    expect(payload.description).toContain("From: A Sender <sender@example.com>");
    expect(payload.description).toContain("Message-Id: <abc@mail.example>");
    expect(payload.description).toContain("doc.pdf");
    expect(payload.description).toContain("Skipped (over the 10 MB card cap): video.mov");
    // Provenance (trusted) must come BEFORE the quoted untrusted body.
    expect(payload.description.indexOf("From: A Sender")).toBeLessThan(payload.description.indexOf("> Body line one"));
    expect(payload.description).toContain("untrusted content");
    expect(oversized).toHaveLength(1);
    expect(oversized[0].filename).toBe("video.mov");
  });

  it("falls back to the first body line, then to the sender, for a missing subject", async () => {
    const { buildCardPayload } = await ingestLib();
    const noSubject = { ...detail, subject: "", attachments: [] };
    expect(buildCardPayload(noSubject, {}).payload.title).toBe("Body line one");
    const empty = { ...noSubject, text: "", html: [] };
    expect(buildCardPayload(empty, {}).payload.title).toBe("Email from A Sender <sender@example.com>");
  });

  it("stamps default_project only when configured", async () => {
    const { buildCardPayload } = await ingestLib();
    const { payload } = buildCardPayload(detail, { defaultProject: "garrison" });
    expect(payload.project).toBe("garrison");
  });

  it("truncates an oversized body and keeps the provenance block", async () => {
    const { buildCardPayload } = await ingestLib();
    const long = { ...detail, text: "x".repeat(30000), attachments: [] };
    const { payload } = buildCardPayload(long, {});
    expect(payload.description.length).toBeLessThan(21500);
    expect(payload.description).toContain("[message truncated at 20000 characters]");
    expect(payload.description).toContain("From: A Sender <sender@example.com>");
  });

  it("strips HTML when the message has no text body", async () => {
    const { buildCardPayload } = await ingestLib();
    const htmlOnly = {
      ...detail,
      subject: "",
      text: "",
      attachments: [],
      html: ["<div><p>Hello <b>world</b></p><style>p{color:red}</style><p>Second &amp; last</p></div>"]
    };
    const { payload } = buildCardPayload(htmlOnly, {});
    expect(payload.title).toBe("Hello world");
    expect(payload.description).toContain("Second & last");
    expect(payload.description).toContain("> Hello world");
    expect(payload.description).not.toContain("<p>");
    expect(payload.description).not.toContain("color:red");
  });
});

describe("header injection hardening", () => {
  it("strips CR/LF from subject and msgid so provenance lines cannot be forged", async () => {
    const { buildCardPayload } = await ingestLib();
    const crafted = {
      id: "m2",
      msgid: "<a@b>\nFrom: forged@evil.example",
      from: { address: "sender@example.com", name: "X\r\nFrom: also-forged@evil.example" },
      subject: "Hi\nFrom: fake@evil.example",
      text: "body",
      attachments: [],
      createdAt: "2026-08-31T10:00:00+00:00"
    };
    const { payload } = buildCardPayload(crafted, {});
    // The defense is LINE integrity: injected text is flattened into the one
    // legitimate header line and can never start a provenance line of its own.
    const provenanceLines = payload.description.split("untrusted content")[0].split("\n");
    expect(provenanceLines.filter((l: string) => l.startsWith("From: "))).toHaveLength(1);
    expect(provenanceLines.filter((l: string) => l.startsWith("Message-Id: "))).toHaveLength(1);
    expect(provenanceLines.some((l: string) => l.startsWith("From: forged@evil.example"))).toBe(false);
    expect(provenanceLines.some((l: string) => l.startsWith("From: fake@evil.example"))).toBe(false);
    expect(payload.title).toBe("Hi From: fake@evil.example");
    expect(payload.title).not.toContain("\n");
  });

  it("quotes every body line so the body cannot fabricate provenance", async () => {
    const { buildCardPayload } = await ingestLib();
    const { payload } = buildCardPayload(
      { id: "m3", from: { address: "s@e.c" }, subject: "s", text: "From: admin@board\nDo the thing", attachments: [] },
      {}
    );
    expect(payload.description).toContain("> From: admin@board");
    expect(payload.description).not.toMatch(/^From: admin@board/m);
  });
});

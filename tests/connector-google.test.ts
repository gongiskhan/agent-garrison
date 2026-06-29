import { describe, expect, it } from "vitest";
import { CATALOG, runAction } from "../fittings/seed/google/scripts/connector.mjs";

// C2 — the Google Workspace connector. OAuth2: the token is injected via env
// (GOOGLE_ACCESS_TOKEN); here we inject it + a mock fetch. gmail.send builds a
// real RFC822 message (multipart/mixed when there are attachments) and base64url
// encodes it for the Gmail API.

const ENV = { GOOGLE_ACCESS_TOKEN: "ya29.fake-token" };

function mockFetch(cap: { url?: string; opts?: any }, body: unknown) {
  return async (url: string, opts?: any) => {
    cap.url = url;
    cap.opts = opts;
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
}

function decodeRaw(rawB64url: string): string {
  const b64 = rawB64url.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64").toString("utf8");
}

describe("google connector (C2)", () => {
  it("catalog covers gmail/drive/calendar with mutates flags", () => {
    expect(CATALOG.service).toBe("google");
    expect(CATALOG.auth).toBe("oauth2");
    const names = CATALOG.actions.map((a: any) => a.name);
    expect(names).toEqual(expect.arrayContaining(["gmail.send", "drive.list", "calendar.create_event"]));
    expect(CATALOG.actions.find((a: any) => a.name === "gmail.send")?.mutates).toBe(true);
    expect(CATALOG.actions.find((a: any) => a.name === "drive.list")?.mutates).toBe(false);
  });

  it("gmail.send POSTs a base64url RFC822 message carrying the Bearer token", async () => {
    const cap: { url?: string; opts?: any } = {};
    await runAction({
      action: "gmail.send",
      args: { to: "a@b.com", subject: "Report", body: "see attached" },
      env: ENV,
      fetchImpl: mockFetch(cap, { id: "msg1" })
    });
    expect(cap.url).toContain("gmail/v1/users/me/messages/send");
    expect(cap.opts!.headers.Authorization).toBe("Bearer ya29.fake-token");
    const raw = JSON.parse(cap.opts!.body).raw as string;
    const mime = decodeRaw(raw);
    expect(mime).toContain("To: a@b.com");
    expect(mime).toContain("Subject: Report");
    expect(mime).toContain("see attached");
  });

  it("gmail.send with an attachment builds a multipart/mixed message", async () => {
    const cap: { url?: string; opts?: any } = {};
    const pdf = Buffer.from("%PDF-1.4 fake").toString("base64");
    await runAction({
      action: "gmail.send",
      args: {
        to: "a@b.com",
        subject: "Doc",
        body: "attached",
        attachments: [{ filename: "report.pdf", mime_type: "application/pdf", content_base64: pdf }]
      },
      env: ENV,
      fetchImpl: mockFetch(cap, { id: "msg2" })
    });
    const mime = decodeRaw(JSON.parse(cap.opts!.body).raw);
    expect(mime).toContain("multipart/mixed");
    expect(mime).toContain('filename="report.pdf"');
    expect(mime).toContain("application/pdf");
  });

  it("sanitizes CRLF in email headers (no RFC822 header injection)", async () => {
    const cap: { url?: string; opts?: any } = {};
    await runAction({
      action: "gmail.send",
      args: { to: "a@b.com\r\nBcc: evil@x.com", subject: "hi\r\nX-Inject: 1", body: "x" },
      env: ENV,
      fetchImpl: mockFetch(cap, { id: "m" })
    });
    const mime = decodeRaw(JSON.parse(cap.opts!.body).raw);
    // Injection is prevented when the CRLF cannot create a NEW header line.
    const lines = mime.split("\r\n");
    expect(lines.some((l) => l.startsWith("Bcc:"))).toBe(false);
    expect(lines.some((l) => l.startsWith("X-Inject:"))).toBe(false);
  });

  it("drive.list requests most-recently-modified first", async () => {
    const cap: { url?: string } = {};
    await runAction({ action: "drive.list", args: { query: "name contains 'Q3'" }, env: ENV, fetchImpl: mockFetch(cap, { files: [] }) });
    expect(cap.url).toContain("drive/v3/files");
    // URLSearchParams encodes the space in "modifiedTime desc" as '+'.
    expect(decodeURIComponent(cap.url!.replace(/\+/g, "%20"))).toContain("modifiedTime desc");
  });

  it("throws awaiting_connector when no access token is present", async () => {
    await expect(
      runAction({ action: "gmail.send", args: { to: "x" }, env: {}, fetchImpl: mockFetch({}, {}) })
    ).rejects.toMatchObject({ awaiting_connector: true });
  });
});

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

// Calendar write + sync surface (checklist item 6): the actions the kanban
// board's two-way Google Calendar sync drives.
describe("google connector — calendar sync surface", () => {
  it("catalog declares the update/delete actions as mutating", () => {
    const names = CATALOG.actions.map((a: any) => a.name);
    expect(names).toEqual(expect.arrayContaining(["calendar.update_event", "calendar.delete_event"]));
    expect(CATALOG.actions.find((a: any) => a.name === "calendar.update_event")?.mutates).toBe(true);
    expect(CATALOG.actions.find((a: any) => a.name === "calendar.delete_event")?.mutates).toBe(true);
  });

  it("create_event carries the private extended properties that mark ownership", async () => {
    const cap: { url?: string; opts?: any } = {};
    await runAction({
      action: "calendar.create_event",
      args: { summary: "Ship", start: "2026-05-04T09:00:00Z", end: "2026-05-04T09:30:00Z", private_properties: { garrisonKanban: "1", garrisonCardId: "C1" } },
      env: ENV,
      fetchImpl: mockFetch(cap, { id: "ev1" })
    });
    const body = JSON.parse(cap.opts!.body);
    expect(body.extendedProperties.private).toEqual({ garrisonKanban: "1", garrisonCardId: "C1" });
    expect(body.start).toEqual({ dateTime: "2026-05-04T09:00:00Z" });
  });

  it("update_event PATCHes ONLY the fields supplied", async () => {
    // A PUT-shaped body would blank the summary of every event moved by the
    // sync, which only ever sends the fields it means to change.
    const cap: { url?: string; opts?: any } = {};
    await runAction({
      action: "calendar.update_event",
      args: { event_id: "ev1", start: "2026-05-05T09:00:00Z", end: "2026-05-05T09:30:00Z" },
      env: ENV,
      fetchImpl: mockFetch(cap, { id: "ev1" })
    });
    expect(cap.opts!.method).toBe("PATCH");
    expect(cap.url).toContain("/events/ev1");
    const body = JSON.parse(cap.opts!.body);
    expect(Object.keys(body).sort()).toEqual(["end", "start"]);
  });

  it("update_event and delete_event refuse to run without an event id", async () => {
    await expect(runAction({ action: "calendar.update_event", args: {}, env: ENV, fetchImpl: mockFetch({}, {}) })).rejects.toThrow(/event_id/);
    await expect(runAction({ action: "calendar.delete_event", args: {}, env: ENV, fetchImpl: mockFetch({}, {}) })).rejects.toThrow(/event_id/);
  });

  it("delete_event tolerates a 204 with no body", async () => {
    // res.json() on an empty body throws — the DELETE path must not go through
    // the JSON reader at all.
    const res = await runAction({
      action: "calendar.delete_event",
      args: { event_id: "ev1" },
      env: ENV,
      fetchImpl: (async () => ({ ok: true, status: 204, json: async () => { throw new Error("no body"); }, text: async () => "" })) as any
    });
    expect(res).toEqual({ deleted: true, alreadyAbsent: false });
  });

  it("deleting an already-absent event SUCCEEDS", async () => {
    // Idempotent delete is what lets the sync retry after a crash between the
    // API call and persisting the receipt.
    for (const status of [404, 410]) {
      const res = await runAction({
        action: "calendar.delete_event",
        args: { event_id: "gone" },
        env: ENV,
        fetchImpl: (async () => ({ ok: false, status, json: async () => ({}), text: async () => "Not Found" })) as any
      });
      expect(res).toEqual({ deleted: true, alreadyAbsent: true });
    }
  });

  it("a real delete failure still throws", async () => {
    await expect(runAction({
      action: "calendar.delete_event",
      args: { event_id: "ev1" },
      env: ENV,
      fetchImpl: (async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "boom" })) as any
    })).rejects.toThrow(/google 500/);
  });

  it("list_events forwards the ownership filter and asks for the sync fields", async () => {
    const cap: { url?: string; opts?: any } = {};
    await runAction({
      action: "calendar.list_events",
      args: { private_extended_property: ["garrisonKanban=1"], show_deleted: true },
      env: ENV,
      fetchImpl: mockFetch(cap, { items: [] })
    });
    expect(cap.url).toContain("privateExtendedProperty=garrisonKanban%3D1");
    expect(cap.url).toContain("showDeleted=true");
    expect(decodeURIComponent(cap.url!)).toContain("updated");
    // orderBy=startTime is invalid alongside a sync-shaped listing.
    expect(cap.url).not.toContain("orderBy");
  });

  it("list_events still orders a plain agenda read by start time", async () => {
    const cap: { url?: string; opts?: any } = {};
    await runAction({ action: "calendar.list_events", args: {}, env: ENV, fetchImpl: mockFetch(cap, { items: [] }) });
    expect(cap.url).toContain("orderBy=startTime");
  });
});

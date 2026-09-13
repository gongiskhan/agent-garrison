import { describe, expect, it, vi } from "vitest";
import files from "../test/fixtures/messages/google/drive-files.json";
import { createGoogleDriveAdapter, DRIVE_ATTACHMENT_MAX_BYTES } from "../packages/messages/providers/google-drive";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Messages Google Drive picker", () => {
  it("lists recent files with bounded page size and metadata only", async () => {
    const fetchImpl = vi.fn(async () => json(files)) as typeof fetch;
    const result = await createGoogleDriveAdapter({ token: "fixture", fetchImpl }).listFiles();
    expect(result.files[0]).toMatchObject({ name: "Fixture report.txt", size: 12, canDownload: true });
    expect(result.nextPageToken).toBe("next-page");
    const query = new URL(String(vi.mocked(fetchImpl).mock.calls[0][0])).searchParams;
    expect(query.get("orderBy")).toBe("modifiedTime desc");
    expect(query.get("pageSize")).toBe("50");
    expect(query.get("q")).toContain("trashed = false");
  });
  it("escapes Drive query syntax and carries pagination", async () => {
    const fetchImpl = vi.fn(async () => json({ files: [] })) as typeof fetch;
    await createGoogleDriveAdapter({ token: "fixture", fetchImpl }).listFiles("client's report", "next");
    const query = new URL(String(vi.mocked(fetchImpl).mock.calls[0][0])).searchParams;
    expect(query.get("q")).toContain("client\\'s report");
    expect(query.get("pageToken")).toBe("next");
  });
  it("returns a normal file as bytes for the confined attachment writer", async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => String(url).includes("alt=media") ? new Response("Fixture data") : json(files.files[0])) as typeof fetch;
    const result = await createGoogleDriveAdapter({ token: "fixture", fetchImpl }).downloadFile("file_small");
    expect(result).toMatchObject({ name: "Fixture report.txt", mime: "text/plain" });
    expect("bytes" in result && Buffer.from(result.bytes).toString()).toBe("Fixture data");
  });
  it("inserts a link for a file over25MB without requesting its content", async () => {
    const fetchImpl = vi.fn(async () => json(files.files[1])) as typeof fetch;
    expect(await createGoogleDriveAdapter({ token: "fixture", fetchImpl }).downloadFile("file_large")).toMatchObject({ link: "https://drive.google.com/file/d/file_large/view", name: "Fixture archive.zip" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("stops unknown-length downloads at25MB and uses the file link", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(DRIVE_ATTACHMENT_MAX_BYTES)); controller.enqueue(new Uint8Array([1])); }, cancel });
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => String(url).includes("alt=media") ? new Response(body) : json({ ...files.files[0], size: undefined })) as typeof fetch;
    expect(await createGoogleDriveAdapter({ token: "fixture", fetchImpl }).downloadFile("file_small")).toHaveProperty("link");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("exports native Google documents as PDF", async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => String(url).includes("/export?") ? new Response("%PDF-fixture") : json(files.files[2])) as typeof fetch;
    expect(await createGoogleDriveAdapter({ token: "fixture", fetchImpl }).downloadFile("file_doc")).toMatchObject({ name: "Fixture notes.pdf", mime: "application/pdf" });
    expect(String(vi.mocked(fetchImpl).mock.calls[1][0])).toContain("mimeType=application%2Fpdf");
  });
  it("keeps a useful link when native export exceeds Google's separate limit", async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => String(url).includes("/export?") ? json({}, 403) : json(files.files[2])) as typeof fetch;
    expect(await createGoogleDriveAdapter({ token: "fixture", fetchImpl }).downloadFile("file_doc")).toMatchObject({ link: "https://docs.google.com/document/d/file_doc/edit" });
  });
  it("honors a provider download restriction", async () => {
    const fetchImpl = vi.fn(async () => json({ ...files.files[0], capabilities: { canDownload: false } })) as typeof fetch;
    expect(await createGoogleDriveAdapter({ token: "fixture", fetchImpl }).downloadFile("file_small")).toHaveProperty("link");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("rejects a path-shaped file id and ignores unsafe provider links", async () => {
    const fetchImpl = vi.fn(async () => json({ ...files.files[1], webViewLink: "javascript:alert(1)" })) as typeof fetch;
    const adapter = createGoogleDriveAdapter({ token: "fixture", fetchImpl });
    await expect(adapter.downloadFile("../secrets")).rejects.toThrow("Invalid Drive file id");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await adapter.downloadFile("file_large")).toMatchObject({ link: "https://drive.google.com/file/d/file_large/view" });
  });
});

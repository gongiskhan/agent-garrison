import { ProviderHttpError, type JsonRecord, type TransportOptions } from "./shared";

export const DRIVE_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export interface DriveFile { id: string; name: string; mimeType: string; size?: number; modifiedTime?: string; webViewLink?: string; canDownload?: boolean }
export type DriveDownload = { file: DriveFile; bytes: Uint8Array; mime: string; name: string } | { file: DriveFile; link: string; name: string };
const fileFields = "id,name,mimeType,size,modifiedTime,webViewLink,capabilities(canDownload)";
function normalizeFile(file: JsonRecord): DriveFile {
  return { id: String(file.id), name: String(file.name), mimeType: String(file.mimeType),
    ...(file.size !== undefined ? { size: Number(file.size) } : {}),
    ...(file.modifiedTime ? { modifiedTime: String(file.modifiedTime) } : {}),
    ...(file.webViewLink ? { webViewLink: String(file.webViewLink) } : {}),
    ...(file.capabilities?.canDownload !== undefined ? { canDownload: Boolean(file.capabilities.canDownload) } : {}) };
}
function driveLink(file: DriveFile) {
  if (file.webViewLink) {
    try { const url = new URL(file.webViewLink); if (url.protocol === "https:" && ["drive.google.com", "docs.google.com"].includes(url.hostname)) return url.href; } catch { /* Use the canonical file link. */ }
  }
  return `https://drive.google.com/file/d/${encodeURIComponent(file.id)}/view`;
}
export function createGoogleDriveAdapter(options: TransportOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  async function request(path: string): Promise<Response> {
    if (!options.token) throw new Error("Connect Google in Connectors");
    const response = await fetchImpl(`https://www.googleapis.com/drive/v3/${path}`, { method: "GET", headers: { authorization: `Bearer ${options.token}` }, signal: AbortSignal.timeout(30_000), redirect: "error" });
    if (!response.ok) throw new ProviderHttpError(response.status, "Google Drive request failed");
    return response;
  }
  return {
    async listFiles(query = "", pageToken?: string) {
      if (query.length > 500) throw new Error("Drive search is too long");
      const escaped = query.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      const params = new URLSearchParams({ q: `trashed = false and mimeType != 'application/vnd.google-apps.folder'${query ? ` and (name contains '${escaped}' or fullText contains '${escaped}')` : ""}`,
        orderBy: "modifiedTime desc", pageSize: "50", fields: `nextPageToken,files(${fileFields})`, supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
      if (pageToken) params.set("pageToken", pageToken);
      const body = await (await request(`files?${params}`)).json();
      return { files: (body.files ?? []).map(normalizeFile), nextPageToken: body.nextPageToken ?? null };
    },
    async downloadFile(fileId: string): Promise<DriveDownload> {
      if (!/^[a-zA-Z0-9_-]+$/.test(fileId)) throw new Error("Invalid Drive file id");
      const file = normalizeFile(await (await request(`files/${encodeURIComponent(fileId)}?${new URLSearchParams({ fields: fileFields, supportsAllDrives: "true" })}`)).json());
      const asLink = () => ({ file, link: driveLink(file), name: file.name });
      if (file.canDownload === false || (file.size ?? 0) > DRIVE_ATTACHMENT_MAX_BYTES) return asLink();
      const native = file.mimeType.startsWith("application/vnd.google-apps.");
      if (native && !["application/vnd.google-apps.document", "application/vnd.google-apps.spreadsheet", "application/vnd.google-apps.presentation", "application/vnd.google-apps.drawing"].includes(file.mimeType)) return asLink();
      const mime = native ? "application/pdf" : file.mimeType;
      const name = native ? `${file.name}.pdf` : file.name;
      let response: Response;
      try {
        response = await request(native ? `files/${encodeURIComponent(fileId)}/export?${new URLSearchParams({ mimeType: mime })}` : `files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`);
      } catch (error) {
        // Drive limits exported native documents separately. Their link is still useful.
        if (native && error instanceof ProviderHttpError && [403, 413].includes(error.status)) return asLink();
        throw error;
      }
      if (Number(response.headers.get("content-length") ?? 0) > DRIVE_ATTACHMENT_MAX_BYTES) { await response.body?.cancel(); return asLink(); }
      const reader = response.body?.getReader();
      if (!reader) return { file, bytes: new Uint8Array(), mime, name };
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        if (length > DRIVE_ATTACHMENT_MAX_BYTES) { await reader.cancel(); return asLink(); }
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return { file, bytes, mime, name };
    }
  };
}

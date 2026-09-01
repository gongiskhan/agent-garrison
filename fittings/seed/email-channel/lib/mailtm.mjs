// Minimal mail.tm API client (https://docs.mail.tm). Free, API-first inbox
// provider: accounts are created entirely over REST (no signup, no API key),
// mailboxes never expire, messages purge after 7 days - so the inbox is a
// QUEUE, not an archive; ingest promptly. Rate limit is 8 QPS/IP; a 30 s poll
// stays far under it. PATCH endpoints require application/merge-patch+json.

function membersOf(data) {
  if (Array.isArray(data)) return data;
  const members = data?.["hydra:member"];
  return Array.isArray(members) ? members : [];
}

export class MailTmError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "MailTmError";
    this.status = status;
  }
}

export class MailTm {
  constructor({ baseUrl = "https://api.mail.tm", fetchImpl = fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
  }

  async request(pathname, { method = "GET", token = null, body = null, contentType = "application/json", timeoutMs = 15000 } = {}) {
    // API Platform switches serialization on Accept: plain application/json
    // drops the hydra envelope entirely (a bare array, no hydra:member), so
    // ask for ld+json and tolerate both shapes anyway.
    const headers = { accept: "application/ld+json" };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body != null) headers["content-type"] = contentType;
    const res = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new MailTmError(
        `mail.tm ${method} ${pathname}: HTTP ${res.status}${text ? ` ${text.slice(0, 200)}` : ""}`,
        res.status
      );
    }
    return res;
  }

  // The single active public domain rotates over time - always resolve it at
  // provision time, never hardcode it. Existing accounts on older domains
  // keep working.
  async activeDomain() {
    const data = await (await this.request("/domains")).json();
    const domain = membersOf(data).find((d) => d?.isActive);
    if (!domain?.domain) throw new MailTmError("no active mail.tm domain", 0);
    return domain.domain;
  }

  async createAccount(address, password) {
    return (await this.request("/accounts", { method: "POST", body: { address, password } })).json();
  }

  async mintToken(address, password) {
    const data = await (await this.request("/token", { method: "POST", body: { address, password } })).json();
    if (!data?.token) throw new MailTmError("mail.tm token response had no token", 0);
    return data.token;
  }

  // Hydra-paginated, 30 per page.
  async listMessages(token, page = 1) {
    const data = await (await this.request(`/messages?page=${page}`, { token })).json();
    const items = membersOf(data);
    return {
      items,
      total: data["hydra:totalItems"] ?? items.length,
      hasNext: Boolean(data["hydra:view"]?.["hydra:next"])
    };
  }

  async getMessage(token, id) {
    return (await this.request(`/messages/${encodeURIComponent(id)}`, { token })).json();
  }

  // downloadUrl comes verbatim from the message detail's attachments[] entry.
  async downloadAttachment(token, downloadUrl) {
    const res = await this.request(downloadUrl, { token, timeoutMs: 60000 });
    return Buffer.from(await res.arrayBuffer());
  }

  async markSeen(token, id) {
    await this.request(`/messages/${encodeURIComponent(id)}`, {
      method: "PATCH",
      token,
      body: { seen: true },
      contentType: "application/merge-patch+json"
    });
  }
}

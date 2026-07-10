// Power Fitting — GCE self-suspend via the metadata server. No SDK, no gcloud:
// we read the instance identity + an OAuth token straight off the metadata
// server (curl-free — Node fetch with the Metadata-Flavor:Google header) and
// POST the Compute Engine `suspend` call ourselves.
//
// `fetchImpl` is injected so tests can prove the request shape and the failure
// handling without touching GCP. NOTHING here throws to the caller — the idle
// watcher must survive a failed suspend — so every path returns a result object.
//
// KNOWN BLOCKER on the current box: the default service-account token minted by
// the metadata server lacks the `cloud-platform` / compute scope, so the suspend
// POST returns 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT. We surface that honestly
// rather than pretending it worked.

const METADATA_BASE = "http://metadata.google.internal/computeMetadata/v1";
const METADATA_HEADERS = { "Metadata-Flavor": "Google" };

async function metadata(fetchImpl, subPath) {
  const res = await fetchImpl(`${METADATA_BASE}/${subPath}`, { headers: METADATA_HEADERS });
  if (!res || !res.ok) {
    throw new Error(`metadata ${subPath} → ${res ? res.status : "no response"}`);
  }
  return (await res.text()).trim();
}

// Resolve { token, project, zone, name } from the metadata server. The zone
// endpoint returns "projects/<num>/zones/<zone>" — we keep the last segment.
export async function resolveInstanceIdentity(fetchImpl) {
  const tokenRaw = await metadata(fetchImpl, "instance/service-accounts/default/token");
  let token;
  try {
    token = JSON.parse(tokenRaw).access_token;
  } catch {
    throw new Error("metadata token payload was not JSON");
  }
  if (!token) throw new Error("metadata token payload had no access_token");
  const project = await metadata(fetchImpl, "project/project-id");
  const zonePath = await metadata(fetchImpl, "instance/zone");
  const zone = zonePath.split("/").pop();
  const name = await metadata(fetchImpl, "instance/name");
  return { token, project, zone, name };
}

export function suspendUrl({ project, zone, name }) {
  return `https://compute.googleapis.com/compute/v1/projects/${project}/zones/${zone}/instances/${name}/suspend`;
}

// Suspend this instance. Returns:
//   { ok: true,  status, request }                         — accepted
//   { ok: false, status, error, request }                  — API rejected (e.g. 403 scope)
//   { ok: false, status: null, error, request: null }      — could not even build the call
// Never throws.
export async function suspendSelf({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") {
    return { ok: false, status: null, error: "no fetch implementation available", request: null };
  }
  let identity;
  try {
    identity = await resolveInstanceIdentity(fetchImpl);
  } catch (err) {
    return { ok: false, status: null, error: String(err?.message ?? err), request: null };
  }

  const url = suspendUrl(identity);
  const request = { method: "POST", url };
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${identity.token}`,
        "Content-Type": "application/json"
      }
    });
    const bodyText = res && typeof res.text === "function" ? await res.text().catch(() => "") : "";
    if (!res || !res.ok) {
      let message = bodyText;
      try {
        const parsed = JSON.parse(bodyText);
        message = parsed?.error?.message ?? bodyText;
      } catch {
        // non-JSON body — keep the raw text
      }
      return { ok: false, status: res ? res.status : null, error: message || "suspend rejected", request };
    }
    return { ok: true, status: res.status, request, body: bodyText };
  } catch (err) {
    return { ok: false, status: null, error: String(err?.message ?? err), request };
  }
}

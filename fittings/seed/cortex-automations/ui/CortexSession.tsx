"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FittingViewProps } from "@/components/fitting-views/registry";
import {
  EmptyNote,
  SaveBadge,
  SectionLabel,
  cardStyle,
  useAutosave
} from "@/components/fitting-views/shared/common";

// A hands-on rig over the key-reachable Cortex capability API: configure the
// origin, confirm the credential exists, call one integration action, start an
// automation run and follow it to a conclusion.
//
// Three things about that API shape this view, and each is easy to get wrong:
//
//  T1  `execute` reports a refusal as HTTP 200 with `{"success": false}`. The
//      transport succeeded; the action did not. Every result here branches on
//      the `success` field, never on the status code.
//  T2  A mutating action answers HTTP 403 with an `awaiting_consent` descriptor
//      naming the real destination. A gateway key CANNOT clear that gate - the
//      approval endpoint is user-authenticated and deliberately off this
//      surface - so this view renders the descriptor and says who must act. It
//      offers no approve button, because there is no approve call to make.
//  T3  There is no event stream here. Run status is POLLED, and nothing in this
//      view is labelled live.
//
// Every request leaves the browser as a same-origin call to Garrison, which
// holds the Vault key and makes the outbound hop (src/lib/cortex-proxy.ts).

const RUN_STORAGE_KEY = "garrison.cortex-automations.runId";
const POLL_MS = 2000;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

interface Upstream {
  status: number;
  statusText: string;
  contentType: string | null;
  body: unknown;
}

interface ProxyResult {
  request: { method: string; path: string };
  upstream: Upstream;
}

interface CortexStatus {
  stationed: boolean;
  compositionId: string | null;
  baseUrl: string | null;
  baseUrlSource: "config" | "env" | null;
  baseUrlError: string | null;
  secretKey: string;
  keySet: boolean;
  vaultLocked: boolean;
}

interface IntegrationDefinition {
  key: string;
  displayName?: string;
  description?: string;
  authType?: string;
  actions?: unknown[];
}

interface CapabilityAction {
  actionName: string;
  description?: string;
  target?: string;
  shape?: string;
  transport?: string;
  requiresApproval?: boolean;
  approved?: boolean;
  authoringState?: string;
}

interface IntegrationCapability {
  integration: IntegrationDefinition;
  connected: boolean;
  actions: CapabilityAction[];
}

interface Automation {
  id: string;
  name?: string;
  description?: string;
  status?: string;
}

interface RunStep {
  stepId?: string;
  index?: number;
  status?: string;
  tier?: string;
  durationMs?: number;
  error?: { message: string; recoverable?: boolean };
  screenshotUrl?: string;
}

interface RunRecord extends Record<string, unknown> {
  id: string;
  automationId?: string;
  status?: string;
  summary?: string;
  startedAt?: string;
  finishedAt?: string;
  steps?: RunStep[];
}

interface RunLogStep {
  stepIndex: number;
  log: string;
  truncated: boolean;
}

async function proxy(
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE" = "GET",
  body?: unknown
): Promise<ProxyResult> {
  const response = await fetch("/api/cortex", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, method, body })
  });
  const data = (await response.json().catch(() => null)) as
    | (ProxyResult & { error?: string })
    | null;
  if (!response.ok) {
    throw new Error(data?.error ?? `Garrison proxy answered HTTP ${response.status}`);
  }
  if (!data) throw new Error("Garrison proxy returned no body");
  return data;
}

/** JSON when it is JSON, the raw text otherwise. Never a summary. */
function render(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function pick(value: unknown, ...keys: string[]): unknown {
  let cursor = value;
  for (const key of keys) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

export default function CortexSession({ entry, config }: FittingViewProps) {
  const [status, setStatus] = useState<CortexStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/cortex", { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as
        | (CortexStatus & { error?: string })
        | null;
      if (!response.ok) throw new Error(data?.error ?? `HTTP ${response.status}`);
      setStatus(data);
      setStatusError(null);
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const ready = !!status?.baseUrl && status.keySet;

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <Settings
        entry={entry}
        config={config}
        status={status}
        statusError={statusError}
        onSaved={refreshStatus}
      />
      <Integrations ready={ready} />
      <Runs ready={ready} />
    </div>
  );
}

// ── Settings ────────────────────────────────────────────────────────────────

function Settings({
  entry,
  config,
  status,
  statusError,
  onSaved
}: {
  entry: FittingViewProps["entry"];
  config: FittingViewProps["config"];
  status: CortexStatus | null;
  statusError: string | null;
  onSaved: () => Promise<void>;
}) {
  const stored = (config as Record<string, unknown> | undefined)?.base_url;
  const [baseUrl, setBaseUrl] = useState(typeof stored === "string" ? stored : "");

  // Autosave, per the Quarters no-Save-button rule: text debounces, blur flushes.
  const { state, error, schedule, flushNow } = useAutosave<string>(async (value) => {
    const response = await fetch("/api/muster/standing/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        faculty: entry.faculty,
        fittingId: entry.id,
        key: "base_url",
        value
      })
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(data?.error ?? `HTTP ${response.status}`);
    }
    await onSaved();
  });

  return (
    <section style={cardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <SectionLabel>Settings</SectionLabel>
        <SaveBadge state={state} error={error} />
      </div>

      <div style={{ display: "grid", gap: 5, marginBottom: 12 }}>
        <label htmlFor="cortex-base-url" className="font-mono" style={{ fontSize: 11.5 }}>
          base_url
        </label>
        <input
          id="cortex-base-url"
          className="text"
          type="text"
          value={baseUrl}
          placeholder="https://cortex.example.com"
          onChange={(event) => {
            setBaseUrl(event.target.value);
            schedule(event.target.value);
          }}
          onBlur={flushNow}
        />
        <span style={{ fontSize: 11.5, lineHeight: 1.5, color: "var(--mute)" }}>
          The Cortex origin. Requests are made by the Garrison server, so a
          machine-local address works here even when this page is open on another
          device.
        </span>
      </div>

      {statusError ? (
        <Problem title="Could not read the session state">{statusError}</Problem>
      ) : !status ? (
        <span style={{ fontSize: 12.5, color: "var(--mute)" }}>Reading state…</span>
      ) : (
        <dl
          style={{
            display: "grid",
            gridTemplateColumns: "max-content 1fr",
            gap: "5px 14px",
            margin: 0,
            fontSize: 12.5
          }}
        >
          <Row label="In use">
            {status.baseUrl ? (
              <>
                <code className="font-mono" style={{ fontSize: 12 }}>
                  {status.baseUrl}
                </code>
                <span style={{ color: "var(--mute)" }}>
                  {" "}
                  (from {status.baseUrlSource === "env" ? "CORTEX_BASE_URL" : "composition config"})
                </span>
              </>
            ) : (
              <span style={{ color: "var(--alarm)" }}>
                {status.baseUrlError ?? "not set - nothing can be called yet"}
              </span>
            )}
          </Row>
          <Row label={status.secretKey}>
            {status.vaultLocked ? (
              <span style={{ color: "var(--alarm)" }}>
                unknown - the Vault is locked, so the key cannot be read
              </span>
            ) : status.keySet ? (
              <span style={{ color: "var(--sage)" }}>set</span>
            ) : (
              <span style={{ color: "var(--alarm)" }}>not set</span>
            )}
            <span style={{ color: "var(--mute)" }}>
              {" "}
              · the value stays on the server -{" "}
              <Link href="/vault" style={{ color: "var(--brass)" }}>
                manage it in the Vault
              </Link>
            </span>
          </Row>
          <Row label="Composition">
            <code className="font-mono" style={{ fontSize: 12 }}>
              {status.compositionId ?? "unknown"}
            </code>
            {status.stationed ? null : (
              <span style={{ color: "var(--alarm)" }}>
                {" "}
                - this Fitting is not stationed there, so config edits have nowhere to land
              </span>
            )}
          </Row>
        </dl>
      )}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="font-mono" style={{ fontSize: 11, color: "var(--mute)" }}>
        {label}
      </dt>
      <dd style={{ margin: 0 }}>{children}</dd>
    </>
  );
}

// ── Integrations ────────────────────────────────────────────────────────────

function Integrations({ ready }: { ready: boolean }) {
  const [items, setItems] = useState<IntegrationDefinition[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [selectedKey, setSelectedKey] = useState("");
  const [capability, setCapability] = useState<IntegrationCapability | null>(null);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);

  const [actionName, setActionName] = useState("");
  const [argsText, setArgsText] = useState("{}");
  const [argsError, setArgsError] = useState<string | null>(null);
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<ProxyResult | null>(null);
  const [executeError, setExecuteError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const data = await proxy("/api/v1/integrations");
      if (data.upstream.status !== 200) {
        throw new Error(
          `Cortex answered HTTP ${data.upstream.status} ${data.upstream.statusText}: ${render(
            data.upstream.body
          )}`
        );
      }
      const list = pick(data.upstream.body, "items");
      setItems(Array.isArray(list) ? (list as IntegrationDefinition[]) : []);
    } catch (error) {
      setItems(null);
      setListError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  const openIntegration = useCallback(async (key: string) => {
    setSelectedKey(key);
    setCapability(null);
    setCapabilityError(null);
    setActionName("");
    setResult(null);
    setExecuteError(null);
    if (!key) return;
    try {
      const data = await proxy(`/api/v1/integrations/${encodeURIComponent(key)}`);
      if (data.upstream.status !== 200) {
        throw new Error(
          `Cortex answered HTTP ${data.upstream.status} ${data.upstream.statusText}: ${render(
            data.upstream.body
          )}`
        );
      }
      setCapability(data.upstream.body as IntegrationCapability);
    } catch (error) {
      setCapabilityError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  async function execute() {
    setArgsError(null);
    setExecuteError(null);
    setResult(null);
    let args: unknown;
    try {
      args = argsText.trim() ? JSON.parse(argsText) : {};
    } catch (error) {
      setArgsError(error instanceof Error ? error.message : String(error));
      return;
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      setArgsError("args must be a JSON object");
      return;
    }
    setExecuting(true);
    try {
      const data = await proxy(
        `/api/v1/integrations/${encodeURIComponent(selectedKey)}/actions/${encodeURIComponent(
          actionName
        )}/execute`,
        "POST",
        { args }
      );
      setResult(data);
    } catch (error) {
      setExecuteError(error instanceof Error ? error.message : String(error));
    } finally {
      setExecuting(false);
    }
  }

  const selectedAction = capability?.actions?.find((a) => a.actionName === actionName);

  return (
    <section style={cardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <SectionLabel>Integrations</SectionLabel>
        <button type="button" className="btn small" onClick={() => void loadList()} disabled={!ready || loading}>
          {loading ? "Loading…" : items ? "Reload" : "Load integrations"}
        </button>
      </div>

      {!ready ? (
        <EmptyNote>Set a base URL and a Vault key above; nothing is callable until both exist.</EmptyNote>
      ) : listError ? (
        <Problem title="Could not list integrations">{listError}</Problem>
      ) : !items ? (
        <EmptyNote>Not loaded yet.</EmptyNote>
      ) : items.length === 0 ? (
        <EmptyNote>This key sees no integrations.</EmptyNote>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          <div style={{ display: "grid", gap: 5 }}>
            <label htmlFor="cortex-integration" className="font-mono" style={{ fontSize: 11.5 }}>
              integration
            </label>
            <select
              id="cortex-integration"
              className="text"
              value={selectedKey}
              onChange={(event) => void openIntegration(event.target.value)}
            >
              <option value="">- pick one -</option>
              {items.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.displayName ? `${item.displayName} (${item.key})` : item.key}
                </option>
              ))}
            </select>
          </div>

          {capabilityError ? (
            <Problem title={`Could not open ${selectedKey}`}>{capabilityError}</Problem>
          ) : null}

          {capability ? (
            <>
              <p style={{ margin: 0, fontSize: 12.5 }}>
                connected:{" "}
                <b style={{ color: capability.connected ? "var(--sage)" : "var(--alarm)" }}>
                  {String(capability.connected)}
                </b>
                {capability.connected ? null : (
                  <span style={{ color: "var(--mute)" }}>
                    {" "}
                    - actions will answer HTTP 200 with {"{\"success\": false, \"code\": \"not_connected\"}"}
                  </span>
                )}
              </p>

              <div style={{ display: "grid", gap: 5 }}>
                <label htmlFor="cortex-action" className="font-mono" style={{ fontSize: 11.5 }}>
                  action
                </label>
                <select
                  id="cortex-action"
                  className="text"
                  value={actionName}
                  onChange={(event) => {
                    setActionName(event.target.value);
                    setResult(null);
                    setExecuteError(null);
                  }}
                >
                  <option value="">- pick one -</option>
                  {(capability.actions ?? []).map((action) => (
                    <option key={action.actionName} value={action.actionName}>
                      {action.actionName}
                      {action.requiresApproval ? " (needs approval)" : ""}
                    </option>
                  ))}
                </select>
              </div>

              {selectedAction ? (
                <div style={{ fontSize: 12.5, lineHeight: 1.6, color: "var(--mute)" }}>
                  {selectedAction.description ? <div>{selectedAction.description}</div> : null}
                  {selectedAction.target ? (
                    <div>
                      target:{" "}
                      <code className="font-mono" style={{ fontSize: 12 }}>
                        {selectedAction.target}
                      </code>
                    </div>
                  ) : null}
                  {selectedAction.shape ? (
                    <div>
                      shape:{" "}
                      <code className="font-mono" style={{ fontSize: 12 }}>
                        {selectedAction.shape}
                      </code>
                    </div>
                  ) : null}
                  {selectedAction.requiresApproval ? (
                    <div style={{ color: "var(--alarm)" }}>
                      requires approval · approved: {String(selectedAction.approved ?? false)}
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div style={{ display: "grid", gap: 5 }}>
                <label htmlFor="cortex-args" className="font-mono" style={{ fontSize: 11.5 }}>
                  args (JSON object)
                </label>
                <textarea
                  id="cortex-args"
                  className="text"
                  rows={5}
                  spellCheck={false}
                  value={argsText}
                  onChange={(event) => setArgsText(event.target.value)}
                  style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 12 }}
                />
                {argsError ? (
                  <span style={{ fontSize: 12, color: "var(--alarm)" }}>args: {argsError}</span>
                ) : null}
              </div>

              <button
                type="button"
                className="btn small primary"
                onClick={() => void execute()}
                disabled={!selectedKey || !actionName || executing}
                style={{ justifySelf: "start" }}
              >
                {executing ? "Executing…" : "Execute"}
              </button>

              {executeError ? <Problem title="Execute failed">{executeError}</Problem> : null}
              {result ? <ExecuteResult result={result} /> : null}
            </>
          ) : null}
        </div>
      )}
    </section>
  );
}

function ExecuteResult({ result }: { result: ProxyResult }) {
  const { upstream } = result;
  const body = upstream.body;
  const success = pick(body, "success");
  const consentCode = pick(body, "error", "details", "code");
  const consentRequest = pick(body, "error", "details", "consentRequest");

  // T2 first: a consent gate is a 403 and would otherwise read as a plain error.
  if (upstream.status === 403 && consentCode === "awaiting_consent") {
    return (
      <div style={{ ...cardStyle, borderLeftColor: "var(--alarm)" }}>
        <SectionLabel>Awaiting consent · HTTP 403</SectionLabel>
        <p style={{ margin: "0 0 8px", fontSize: 12.5, lineHeight: 1.6 }}>
          This action mutates something, and Cortex is holding it until a human approves
          the destination below. <b>An API key cannot grant that approval</b> - the
          approval endpoint is user-authenticated and is deliberately not reachable with a
          gateway key. Someone has to approve it in the Ekoa UI, then this action can be
          run again from here.
        </p>
        {consentRequest ? (
          <ConsentDescriptor value={consentRequest} />
        ) : (
          <EmptyNote>No consentRequest descriptor came back.</EmptyNote>
        )}
        <Raw label="Full response" value={body} />
      </div>
    );
  }

  // T1: HTTP 200 is not success. The `success` field is.
  if (upstream.status === 200 && success === false) {
    return (
      <div style={{ ...cardStyle, borderLeftColor: "var(--alarm)" }}>
        <SectionLabel>Refused · HTTP 200, success false</SectionLabel>
        <p style={{ margin: "0 0 8px", fontSize: 12.5, lineHeight: 1.6 }}>
          The request reached Cortex and was answered; the action did not run.
          {typeof pick(body, "code") === "string" ? (
            <>
              {" "}
              code:{" "}
              <code className="font-mono" style={{ fontSize: 12 }}>
                {String(pick(body, "code"))}
              </code>
            </>
          ) : null}
        </p>
        <Raw label="Full response" value={body} />
      </div>
    );
  }

  if (upstream.status === 200 && success === true) {
    return (
      <div style={{ ...cardStyle, borderLeftColor: "var(--sage)" }}>
        <SectionLabel>Success · HTTP 200, success true</SectionLabel>
        <Raw label="Full response" value={body} open />
      </div>
    );
  }

  return (
    <div style={{ ...cardStyle, borderLeftColor: "var(--alarm)" }}>
      <SectionLabel>
        HTTP {upstream.status} {upstream.statusText}
      </SectionLabel>
      <Raw label="Full response" value={body} open />
    </div>
  );
}

function ConsentDescriptor({ value }: { value: unknown }) {
  const fields: Array<[string, string]> = [
    ["integrationKey", "integration"],
    ["actionName", "action"],
    ["description", "description"],
    ["target", "target (the real destination)"],
    ["shape", "shape"]
  ];
  return (
    <dl
      style={{
        display: "grid",
        gridTemplateColumns: "max-content 1fr",
        gap: "4px 14px",
        margin: "0 0 10px",
        fontSize: 12.5
      }}
    >
      {fields.map(([key, label]) => {
        const found = pick(value, key);
        if (found === undefined || found === null) return null;
        return (
          <Row key={key} label={label}>
            <code className="font-mono" style={{ fontSize: 12, wordBreak: "break-all" }}>
              {typeof found === "string" ? found : render(found)}
            </code>
          </Row>
        );
      })}
    </dl>
  );
}

// ── Runs ────────────────────────────────────────────────────────────────────

function Runs({ ready }: { ready: boolean }) {
  const [automations, setAutomations] = useState<Automation[] | null>(null);
  const [automationsError, setAutomationsError] = useState<string | null>(null);
  const [automationId, setAutomationId] = useState("");
  const [inputsText, setInputsText] = useState("{}");
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const [runId, setRunId] = useState("");
  const [runIdDraft, setRunIdDraft] = useState("");
  const [run, setRun] = useState<RunRecord | null>(null);
  const [logs, setLogs] = useState<RunLogStep[] | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [following, setFollowing] = useState(true);
  const [lastPolledAt, setLastPolledAt] = useState<string | null>(null);

  // The run id survives a reload so a long run can be picked back up later.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(RUN_STORAGE_KEY);
    if (stored) {
      setRunId(stored);
      setRunIdDraft(stored);
    }
  }, []);

  const adoptRun = useCallback((id: string) => {
    setRunId(id);
    setRunIdDraft(id);
    setRun(null);
    setLogs(null);
    setRunError(null);
    setFollowing(true);
    if (typeof window !== "undefined") {
      if (id) window.localStorage.setItem(RUN_STORAGE_KEY, id);
      else window.localStorage.removeItem(RUN_STORAGE_KEY);
    }
  }, []);

  const loadAutomations = useCallback(async () => {
    setAutomationsError(null);
    try {
      const data = await proxy("/api/v1/automations");
      if (data.upstream.status !== 200) {
        throw new Error(
          `Cortex answered HTTP ${data.upstream.status} ${data.upstream.statusText}: ${render(
            data.upstream.body
          )}`
        );
      }
      const list = pick(data.upstream.body, "items");
      setAutomations(Array.isArray(list) ? (list as Automation[]) : []);
    } catch (error) {
      setAutomations(null);
      setAutomationsError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  async function startRun() {
    setStartError(null);
    let inputs: unknown;
    try {
      inputs = inputsText.trim() ? JSON.parse(inputsText) : {};
    } catch (error) {
      setStartError(`inputs: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    setStarting(true);
    try {
      const data = await proxy(
        `/api/v1/automations/${encodeURIComponent(automationId)}/runs`,
        "POST",
        { inputs }
      );
      const id = pick(data.upstream.body, "runId");
      if (typeof id !== "string" || !id) {
        throw new Error(
          `no runId in the response (HTTP ${data.upstream.status}): ${render(data.upstream.body)}`
        );
      }
      adoptRun(id);
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error));
    } finally {
      setStarting(false);
    }
  }

  // Polling, not streaming (T3): the key-reachable API has no event stream.
  // A tick makes two sequential calls, so a slow far side must not stack ticks.
  const polling = useRef(false);
  useEffect(() => {
    if (!ready || !runId || !following) return;
    let cancelled = false;

    async function tick() {
      if (polling.current) return;
      polling.current = true;
      try {
        const record = await proxy(`/api/v1/automations/runs/${encodeURIComponent(runId)}`);
        if (cancelled) return;
        if (record.upstream.status !== 200) {
          setRunError(
            `Cortex answered HTTP ${record.upstream.status} ${record.upstream.statusText}: ${render(
              record.upstream.body
            )}`
          );
          setFollowing(false);
          return;
        }
        const parsed = record.upstream.body as RunRecord;
        setRun(parsed);
        setRunError(null);
        setLastPolledAt(new Date().toISOString());

        const logsResult = await proxy(
          `/api/v1/automations/runs/${encodeURIComponent(runId)}/logs`
        );
        if (cancelled) return;
        if (logsResult.upstream.status === 200) {
          const steps = pick(logsResult.upstream.body, "steps");
          setLogs(Array.isArray(steps) ? (steps as RunLogStep[]) : []);
        }

        if (parsed.status && TERMINAL.has(parsed.status)) setFollowing(false);
      } catch (error) {
        if (cancelled) return;
        setRunError(error instanceof Error ? error.message : String(error));
        setFollowing(false);
      } finally {
        polling.current = false;
      }
    }

    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [ready, runId, following]);

  const terminal = !!run?.status && TERMINAL.has(run.status);

  return (
    <section style={cardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <SectionLabel>Runs</SectionLabel>
        <button
          type="button"
          className="btn small"
          onClick={() => void loadAutomations()}
          disabled={!ready}
        >
          {automations ? "Reload automations" : "Load automations"}
        </button>
      </div>

      {!ready ? (
        <EmptyNote>Set a base URL and a Vault key above; nothing is callable until both exist.</EmptyNote>
      ) : (
        <div style={{ display: "grid", gap: 14 }}>
          {automationsError ? (
            <Problem title="Could not list automations">{automationsError}</Problem>
          ) : null}

          {automations ? (
            <div style={{ display: "grid", gap: 8 }}>
              <div style={{ display: "grid", gap: 5 }}>
                <label htmlFor="cortex-automation" className="font-mono" style={{ fontSize: 11.5 }}>
                  automation
                </label>
                <select
                  id="cortex-automation"
                  className="text"
                  value={automationId}
                  onChange={(event) => setAutomationId(event.target.value)}
                >
                  <option value="">- pick one -</option>
                  {automations.map((automation) => (
                    <option key={automation.id} value={automation.id}>
                      {automation.name ? `${automation.name} (${automation.id})` : automation.id}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ display: "grid", gap: 5 }}>
                <label htmlFor="cortex-inputs" className="font-mono" style={{ fontSize: 11.5 }}>
                  inputs (JSON object)
                </label>
                <textarea
                  id="cortex-inputs"
                  className="text"
                  rows={3}
                  spellCheck={false}
                  value={inputsText}
                  onChange={(event) => setInputsText(event.target.value)}
                  style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 12 }}
                />
              </div>
              <button
                type="button"
                className="btn small primary"
                onClick={() => void startRun()}
                disabled={!automationId || starting}
                style={{ justifySelf: "start" }}
              >
                {starting ? "Starting…" : "Start run"}
              </button>
              {startError ? <Problem title="Could not start the run">{startError}</Problem> : null}
            </div>
          ) : null}

          <div style={{ display: "grid", gap: 5 }}>
            <label htmlFor="cortex-run-id" className="font-mono" style={{ fontSize: 11.5 }}>
              run id (kept in this browser, so a run can be picked up later)
            </label>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                id="cortex-run-id"
                className="text"
                type="text"
                value={runIdDraft}
                placeholder="paste a run id to follow it"
                onChange={(event) => setRunIdDraft(event.target.value)}
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="btn small"
                onClick={() => adoptRun(runIdDraft.trim())}
                disabled={!runIdDraft.trim() || runIdDraft.trim() === runId}
              >
                Follow
              </button>
              <button
                type="button"
                className="btn small"
                onClick={() => adoptRun("")}
                disabled={!runId}
              >
                Clear
              </button>
            </div>
          </div>

          {runId ? (
            <RunDetail
              runId={runId}
              run={run}
              logs={logs}
              error={runError}
              following={following}
              terminal={terminal}
              lastPolledAt={lastPolledAt}
              onToggleFollow={() => setFollowing((value) => !value)}
              onAfterGateAction={() => setFollowing(true)}
            />
          ) : (
            <EmptyNote>No run is being followed.</EmptyNote>
          )}
        </div>
      )}
    </section>
  );
}

function RunDetail({
  runId,
  run,
  logs,
  error,
  following,
  terminal,
  lastPolledAt,
  onToggleFollow,
  onAfterGateAction
}: {
  runId: string;
  run: RunRecord | null;
  logs: RunLogStep[] | null;
  error: string | null;
  following: boolean;
  terminal: boolean;
  lastPolledAt: string | null;
  onToggleFollow: () => void;
  onAfterGateAction: () => void;
}) {
  const logByIndex = new Map((logs ?? []).map((step) => [step.stepIndex, step]));
  const status = run?.status ?? "unknown";

  return (
    <div style={{ ...cardStyle, borderLeftColor: terminal ? "var(--sage)" : "var(--brass)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
        <SectionLabel>
          Run {runId} · {status}
        </SectionLabel>
        <button type="button" className="btn small" onClick={onToggleFollow}>
          {following ? "Stop polling" : "Poll"}
        </button>
      </div>

      <p style={{ margin: "0 0 10px", fontSize: 11.5, color: "var(--mute)" }}>
        {following
          ? `Polling every ${POLL_MS / 1000}s. This API has no event stream - nothing here is live.`
          : terminal
            ? "Terminal. Polling stopped."
            : "Polling stopped."}
        {lastPolledAt ? ` Last read ${lastPolledAt}.` : ""}
      </p>

      {error ? <Problem title="Polling failed">{error}</Problem> : null}

      {run ? (
        <>
          <dl
            style={{
              display: "grid",
              gridTemplateColumns: "max-content 1fr",
              gap: "4px 14px",
              margin: "0 0 12px",
              fontSize: 12.5
            }}
          >
            <Row label="automationId">
              <code className="font-mono" style={{ fontSize: 12 }}>
                {run.automationId ?? "-"}
              </code>
            </Row>
            <Row label="startedAt">{run.startedAt ?? "-"}</Row>
            <Row label="finishedAt">{run.finishedAt ?? "-"}</Row>
            {run.summary ? <Row label="summary">{run.summary}</Row> : null}
          </dl>

          <GatePanel run={run} runId={runId} onActed={onAfterGateAction} />

          <SectionLabel>Steps · {(run.steps ?? []).length}</SectionLabel>
          {(run.steps ?? []).length === 0 ? (
            <EmptyNote>No steps reported yet.</EmptyNote>
          ) : (
            <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
              {(run.steps ?? []).map((step, position) => {
                const index = step.index ?? position;
                const log = logByIndex.get(index);
                return (
                  <li
                    key={step.stepId ?? `step-${index}`}
                    style={{ borderLeft: "2px solid var(--rule-2)", paddingLeft: 10 }}
                  >
                    <div style={{ fontSize: 12.5 }}>
                      <span className="font-mono" style={{ fontSize: 11.5, color: "var(--mute)" }}>
                        #{index}
                      </span>{" "}
                      <b>{step.status ?? "unknown"}</b>
                      {step.tier ? (
                        <span className="font-mono" style={{ fontSize: 11, color: "var(--mute)" }}>
                          {" "}
                          · tier {step.tier}
                        </span>
                      ) : null}
                      {typeof step.durationMs === "number" ? (
                        <span className="font-mono" style={{ fontSize: 11, color: "var(--mute)" }}>
                          {" "}
                          · {step.durationMs} ms
                        </span>
                      ) : null}
                      {step.stepId ? (
                        <span className="font-mono" style={{ fontSize: 11, color: "var(--mute)" }}>
                          {" "}
                          · {step.stepId}
                        </span>
                      ) : null}
                    </div>
                    {step.error ? (
                      <div style={{ fontSize: 12.5, color: "var(--alarm)", lineHeight: 1.55 }}>
                        {step.error.message}
                        {step.error.recoverable !== undefined
                          ? ` (recoverable: ${String(step.error.recoverable)})`
                          : ""}
                      </div>
                    ) : null}
                    {/* Keyed on the url so a step whose screenshot changes gets a
                        fresh component, rather than inheriting the previous
                        one's failed state and showing an error for an image
                        that was never tried. */}
                    {step.screenshotUrl ? (
                      <Screenshot key={step.screenshotUrl} url={step.screenshotUrl} />
                    ) : null}
                    {log ? (
                      <details style={{ marginTop: 6 }}>
                        <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--mute)" }}>
                          log{log.truncated ? " (truncated)" : ""}
                        </summary>
                        <pre style={preStyle}>{log.log}</pre>
                      </details>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}

          <Raw label="Full run record" value={run} />
        </>
      ) : error ? null : (
        <span style={{ fontSize: 12.5, color: "var(--mute)" }}>Reading the run…</span>
      )}
    </div>
  );
}

// A screenshot lives on the Cortex host, which is often machine-local and
// usually needs the key. Both reasons it goes back through Garrison rather than
// into an <img src> the browser resolves itself.
function Screenshot({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  const proxied = `/api/cortex/asset?url=${encodeURIComponent(url)}`;
  return (
    <div style={{ marginTop: 6 }}>
      {failed ? (
        <span style={{ fontSize: 12, color: "var(--alarm)" }}>
          Could not load the screenshot through the Garrison proxy.
        </span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={proxied}
          alt={`screenshot ${url}`}
          onError={() => setFailed(true)}
          style={{ maxWidth: "100%", border: "1px solid var(--rule)" }}
        />
      )}
      <div className="font-mono" style={{ fontSize: 11, color: "var(--mute)", wordBreak: "break-all" }}>
        {url}
      </div>
    </div>
  );
}

// Gates: `awaiting_consent` takes a decision, `paused_for_user` takes a resume.
// Everything else non-terminal just keeps polling.
function GatePanel({
  run,
  runId,
  onActed
}: {
  run: RunRecord;
  runId: string;
  onActed: () => void;
}) {
  const [decision, setDecision] = useState<"once" | "always" | "stop">("once");
  const [shape, setShape] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<ProxyResult | null>(null);

  const pending =
    (run.consentRequest as unknown) ?? (run.pendingConsent as unknown) ?? (run.consent as unknown);

  // Depend on the shape VALUE, not on `pending`. The run record is a fresh
  // object on every poll, so an effect keyed on it re-ran twice a second and
  // overwrote whatever the user was typing into this field.
  const found = pick(pending, "shape");
  const pendingShape = typeof found === "string" ? found : "";
  useEffect(() => {
    if (pendingShape) setShape(pendingShape);
  }, [pendingShape]);

  if (run.status !== "awaiting_consent" && run.status !== "paused_for_user") return null;

  async function send(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    setAnswer(null);
    try {
      const data = await proxy(path, "POST", body);
      setAnswer(data);
      onActed();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ ...cardStyle, borderLeftColor: "var(--alarm)", marginBottom: 12 }}>
      <SectionLabel>Pending · {run.status}</SectionLabel>
      {pending ? (
        <>
          <p style={{ margin: "0 0 6px", fontSize: 12.5 }}>What the run is waiting on:</p>
          <pre style={preStyle}>{render(pending)}</pre>
        </>
      ) : (
        <p style={{ margin: "0 0 8px", fontSize: 12.5, color: "var(--mute)" }}>
          The run record carries no gate descriptor; the full record is below.
        </p>
      )}

      {run.status === "awaiting_consent" ? (
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div style={{ display: "grid", gap: 4 }}>
              <label htmlFor="cortex-decision" className="font-mono" style={{ fontSize: 11.5 }}>
                decision
              </label>
              <select
                id="cortex-decision"
                className="text"
                value={decision}
                onChange={(event) => setDecision(event.target.value as typeof decision)}
              >
                <option value="once">once</option>
                <option value="always">always</option>
                <option value="stop">stop</option>
              </select>
            </div>
            <div style={{ display: "grid", gap: 4, flex: 1, minWidth: 220 }}>
              <label htmlFor="cortex-shape" className="font-mono" style={{ fontSize: 11.5 }}>
                shape
              </label>
              <input
                id="cortex-shape"
                className="text"
                type="text"
                value={shape}
                placeholder="the shape the gate names"
                onChange={(event) => setShape(event.target.value)}
              />
            </div>
            <button
              type="button"
              className="btn small primary"
              disabled={busy || !shape.trim()}
              onClick={() =>
                void send(`/api/v1/automations/runs/${encodeURIComponent(runId)}/consent`, {
                  decision,
                  shape: shape.trim()
                })
              }
            >
              {busy ? "Sending…" : "Send consent"}
            </button>
          </div>
          <span style={{ fontSize: 11.5, color: "var(--mute)" }}>
            This is the run-level consent call, which a gateway key may make. It is not the
            integration approval an <code>awaiting_consent</code> execute error asks for - that
            one only a signed-in human can grant.
          </span>
        </div>
      ) : (
        <button
          type="button"
          className="btn small primary"
          disabled={busy}
          style={{ justifySelf: "start" }}
          onClick={() => void send(`/api/v1/automations/runs/${encodeURIComponent(runId)}/resume`)}
        >
          {busy ? "Resuming…" : "Resume"}
        </button>
      )}

      {error ? <Problem title="The gate call failed">{error}</Problem> : null}
      {answer ? (
        <div style={{ marginTop: 8 }}>
          <Raw
            label={`Answer · HTTP ${answer.upstream.status} ${answer.upstream.statusText}`}
            value={answer.upstream.body}
            open
          />
        </div>
      ) : null}
    </div>
  );
}

// ── Small shared bits ───────────────────────────────────────────────────────

const preStyle: React.CSSProperties = {
  margin: "6px 0 0",
  padding: "8px 10px",
  background: "var(--paper)",
  border: "1px solid var(--rule)",
  fontSize: 11.5,
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  maxHeight: 340,
  overflow: "auto"
};

function Raw({ label, value, open }: { label: string; value: unknown; open?: boolean }) {
  return (
    <details open={open} style={{ marginTop: 8 }}>
      <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--mute)" }}>{label}</summary>
      <pre style={preStyle}>{render(value)}</pre>
    </details>
  );
}

// Errors are shown whole. A rig whose failures are summarised is a rig you
// cannot debug from.
function Problem({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      role="alert"
      style={{
        border: "1px solid var(--rule)",
        borderLeft: "2px solid var(--alarm)",
        background: "var(--surface)",
        padding: "10px 12px",
        marginTop: 8
      }}
    >
      <div
        className="font-mono"
        style={{
          fontSize: 10,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: "var(--alarm)",
          marginBottom: 5
        }}
      >
        {title}
      </div>
      <pre style={{ ...preStyle, margin: 0, background: "transparent", border: "none", padding: 0 }}>
        {children}
      </pre>
    </div>
  );
}

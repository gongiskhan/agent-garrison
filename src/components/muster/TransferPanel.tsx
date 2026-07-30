"use client";

// Muster > Transfer - composition import/export.
//
// A composition is the whole shape of an operative: which Fittings are
// stationed and how they are configured, the duties and targets it routes over,
// the orchestrator and soul prompts, the routing policy. Until now that only
// ever existed as a directory on one machine. This panel makes it a document:
// one .garrison.json you can download, commit, hand to someone, and import
// back here or on another box.
//
// The panel is deliberately explicit on both sides. Export lists every file
// that travels AND everything that deliberately does not (secrets first).
// Import always previews against THIS machine before it writes anything - which
// Fittings are missing here, which vault keys are unset, what id it will land
// on - because an import that surprises you is one you have to undo by hand.

import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { BundleInspection, CompositionBundle } from "@/lib/composition-transfer";
import styles from "./Transfer.module.css";

interface ExportPayload {
  bundle: CompositionBundle;
  inspection: BundleInspection;
  warnings: string[];
  filename: string;
}

// A pasted or dropped bundle is untrusted text; the server is the only parser.
// 16 MB is far past the 8 MB the exporter can produce and stops a stray video
// dropped on the zone from being read into memory.
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function TransferPanel({
  compositionId,
  compositionName
}: {
  compositionId: string;
  compositionName: string;
}) {
  return (
    <div data-testid="transfer-panel">
      <div className={styles.panelHead}>
        <p className={styles.panelLead}>
          Move a composition between machines as one portable document. An export carries what you
          authored - stationed Fittings and their config, duties, targets, prompts, routing policy -
          and never carries a secret. An import previews against this machine before it writes
          anything.
        </p>
      </div>
      <div className={styles.bays}>
        <ExportBay compositionId={compositionId} compositionName={compositionName} />
        <ImportBay />
      </div>
    </div>
  );
}

// ── export ──────────────────────────────────────────────────────────────────

function ExportBay({
  compositionId,
  compositionName
}: {
  compositionId: string;
  compositionName: string;
}) {
  const [payload, setPayload] = useState<ExportPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");

  useEffect(() => {
    let cancelled = false;
    setPayload(null);
    setError(null);
    (async () => {
      try {
        const res = await fetch(`/api/compositions/${encodeURIComponent(compositionId)}/export`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (!cancelled) setPayload(data as ExportPayload);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [compositionId]);

  const copy = useCallback(async () => {
    if (!payload) return;
    try {
      await navigator.clipboard.writeText(`${JSON.stringify(payload.bundle, null, 2)}\n`);
      setCopied("ok");
    } catch {
      // Clipboard access needs a secure context and user permission; over the
      // tailnet (HTTPS) and on localhost it is available, but say so rather than
      // appearing to have copied nothing.
      setCopied("fail");
    }
    window.setTimeout(() => setCopied("idle"), 2600);
  }, [payload]);

  const totalBytes = payload?.inspection.files.reduce((sum, file) => sum + file.bytes, 0) ?? 0;
  const missingFittings = payload?.inspection.fittings.filter((f) => !f.present) ?? [];

  return (
    <section className={styles.bay} aria-labelledby="transfer-export-title" data-testid="transfer-export">
      <div className={styles.bayHead}>
        <p className={styles.bayKicker}>Export</p>
        <h3 className={styles.bayTitle} id="transfer-export-title">
          {compositionName}
        </h3>
        <p className={styles.bayHint}>
          Everything below becomes one <code>{payload?.filename ?? `${compositionId}.garrison.json`}</code>{" "}
          file.
        </p>
      </div>
      <div className={styles.bayBody}>
        {error ? (
          <div className={clsx(styles.notice, styles.noticeAlarm)} role="alert">
            <span className={styles.noticeGlyph}>!</span>
            <div className={styles.noticeBody}>
              <h5>Could not build the bundle</h5>
              <p>{error}</p>
            </div>
          </div>
        ) : null}

        {!payload && !error ? (
          <div aria-hidden>
            <div className={styles.skelLine} style={{ width: "45%", marginBottom: 12 }} />
            <div className={styles.skelLine} style={{ width: "90%", marginBottom: 8 }} />
            <div className={styles.skelLine} style={{ width: "70%" }} />
          </div>
        ) : null}

        {payload ? (
          <>
            <div className={styles.stats} data-testid="export-stats">
              <span>
                <span className={styles.statStrong}>{payload.inspection.files.length}</span> files
              </span>
              <span>·</span>
              <span>
                <span className={styles.statStrong}>{payload.inspection.fittings.length}</span> fittings
              </span>
              <span>·</span>
              <span>
                <span className={styles.statStrong}>{payload.inspection.duties}</span> duties
              </span>
              <span>·</span>
              <span>
                <span className={styles.statStrong}>{payload.inspection.targets}</span> targets
              </span>
              <span>·</span>
              <span>
                <span className={styles.statStrong}>{payload.inspection.secrets.length}</span> vault keys
              </span>
              <span>·</span>
              <span className={styles.statStrong}>{formatBytes(totalBytes)}</span>
            </div>

            <div className={styles.actions}>
              {/* Relative href: the browser is almost never on the Garrison box,
                  so an absolute machine-local URL would be unreachable and, over
                  HTTPS, blocked as mixed content. */}
              <a
                className={styles.primaryBtn}
                href={`/api/compositions/${encodeURIComponent(compositionId)}/export?download=1`}
                download={payload.filename}
                data-testid="export-download"
              >
                Download bundle
              </a>
              <button type="button" className={styles.ghostBtn} onClick={copy} data-testid="export-copy">
                {copied === "ok" ? "Copied" : copied === "fail" ? "Copy failed" : "Copy JSON"}
              </button>
            </div>

            {payload.warnings.length > 0 ? (
              <div className={clsx(styles.notice, styles.noticeWarn)} role="status">
                <span className={styles.noticeGlyph}>!</span>
                <div className={styles.noticeBody}>
                  <h5>Left out of the bundle</h5>
                  <ul>
                    {payload.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : null}

            <div className={styles.group}>
              <p className={styles.groupLabel}>Files included</p>
              {payload.inspection.files.length === 0 ? (
                <div className={styles.state}>
                  This composition has no authored files yet - the bundle carries the manifest alone.
                </div>
              ) : (
                <ul className={styles.fileList} data-testid="export-files">
                  {payload.inspection.files.map((file) => (
                    <li className={styles.fileRow} key={file.path}>
                      <span className={styles.filePath}>{file.path}</span>
                      <span className={styles.fileMeta}>
                        {file.label} · {formatBytes(file.bytes)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className={styles.group}>
              <p className={styles.groupLabel}>
                Vault keys the recipient must set ({payload.inspection.secrets.length})
              </p>
              {payload.inspection.secrets.length === 0 ? (
                <div className={styles.state}>No stationed Fitting names a vault secret.</div>
              ) : (
                <ul className={styles.plainList}>
                  {payload.inspection.secrets.map((secret) => (
                    <li className={styles.reqRow} key={secret.key}>
                      <span className={clsx(styles.reqMark, secret.set ? styles.markOk : styles.markMissing)}>
                        {secret.set ? "+" : "!"}
                      </span>
                      <span className={styles.reqName}>{secret.key}</span>
                      <span className={styles.reqNote}>{secret.set ? "set here" : "not set here"}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {missingFittings.length > 0 ? (
              <div className={clsx(styles.notice, styles.noticeWarn)} role="status">
                <span className={styles.noticeGlyph}>!</span>
                <div className={styles.noticeBody}>
                  <h5>{missingFittings.length} stationed Fitting not in this registry</h5>
                  <p>
                    {missingFittings.map((f) => f.id).join(", ")} - the bundle still names them, but
                    whoever imports it needs those Fittings too.
                  </p>
                </div>
              </div>
            ) : null}

            <div className={styles.excluded}>
              <b>Never in a bundle.</b> The recipient supplies these themselves:
              <ul>
                {payload.inspection.excluded.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}

// ── import ──────────────────────────────────────────────────────────────────

type ImportPhase = "empty" | "reading" | "preview" | "importing" | "done";

function ImportBay() {
  const [phase, setPhase] = useState<ImportPhase>("empty");
  const [raw, setRaw] = useState<string | null>(null);
  const [inspection, setInspection] = useState<BundleInspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [imported, setImported] = useState<{ id: string; name: string } | null>(null);
  const [switching, setSwitching] = useState(false);
  // WHICH id the inspection currently in state was computed for. "Is the id
  // still being checked?" is then derived (checkedId !== the typed id) rather
  // than tracked as a boolean — a boolean cannot tell a landed check apart from
  // one still sitting in the debounce window, so it cleared early and left
  // Import enabled against the previous id's verdict.
  const [checkedId, setCheckedId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Only the newest preview may land: the id field re-previews on every
  // keystroke (debounced), so a slow earlier response must not overwrite a
  // later one and resurrect a stale availability verdict.
  const previewSeqRef = useRef(0);

  const runPreview = useCallback(async (text: string, requestedId?: string) => {
    const seq = ++previewSeqRef.current;
    try {
      const res = await fetch("/api/compositions/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bundle: text, id: requestedId, preview: true })
      });
      const data = await res.json();
      if (seq !== previewSeqRef.current) return;
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const next = data.inspection as BundleInspection;
      setInspection(next);
      // The id this verdict actually speaks for. On the first read there is no
      // requested id, so the server checked the BUNDLE's own id — not the
      // suggestion the field is about to be seeded with. Recording the
      // suggestion here would pin a "taken" verdict onto the free id we just
      // offered, which rendered as `"x-2" is taken - x-2 is free` and disabled
      // Import on a perfectly good name.
      setCheckedId(requestedId?.trim() || next.composition.id);
      setError(null);
      setPhase("preview");
      return next;
    } catch (err) {
      if (seq !== previewSeqRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
      setInspection(null);
      setCheckedId(null);
      setPhase("empty");
      return undefined;
    }
  }, []);

  const accept = useCallback(
    async (text: string) => {
      setPhase("reading");
      setError(null);
      setImported(null);
      setRaw(text);
      const next = await runPreview(text);
      if (!next) return;
      // Seed the fields from the bundle, landing on the free id the server
      // picked rather than one that would fail on submit.
      setId(next.suggestedId);
      setName(next.composition.name);
    },
    [runPreview]
  );

  const acceptFile = useCallback(
    async (file: File) => {
      if (file.size > MAX_UPLOAD_BYTES) {
        setError(`${file.name} is ${formatBytes(file.size)} - too large to be a composition bundle`);
        setPhase("empty");
        return;
      }
      await accept(await file.text());
    },
    [accept]
  );

  // Re-check id availability as it is typed, without hammering the endpoint.
  useEffect(() => {
    if (phase !== "preview" || !raw || !id.trim()) return;
    if (id.trim() === checkedId) return; // already the verdict on screen
    const timer = window.setTimeout(() => void runPreview(raw, id.trim()), 400);
    return () => window.clearTimeout(timer);
  }, [checkedId, id, phase, raw, runPreview]);

  const reset = useCallback(() => {
    previewSeqRef.current += 1;
    setPhase("empty");
    setRaw(null);
    setInspection(null);
    setError(null);
    setImported(null);
    setPasteText("");
    setPasteOpen(false);
    setId("");
    setName("");
    setCheckedId(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  const doImport = useCallback(async () => {
    if (!raw) return;
    setPhase("importing");
    setError(null);
    try {
      const res = await fetch("/api/compositions/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bundle: raw, id: id.trim() || undefined, name: name.trim() || undefined })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setImported({ id: data.composition.id as string, name: data.composition.name as string });
      setInspection((data.inspection as BundleInspection) ?? inspection);
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("preview");
    }
  }, [id, inspection, name, raw]);

  // Activating goes through the SAME clean switch as the sidebar selector
  // (resolve -> down -> pointer -> up), so a freshly imported composition is
  // never started by a second, divergent path.
  const activate = useCallback(async () => {
    if (!imported || switching) return;
    setSwitching(true);
    setError(null);
    try {
      const res = await fetch("/api/composition/switch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: imported.id })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok !== true) {
        throw new Error(typeof data?.error === "string" ? data.error : res.statusText);
      }
      window.location.assign("/muster");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSwitching(false);
    }
  }, [imported, switching]);

  const blocked = (inspection?.errors.length ?? 0) > 0;
  // The verdict on screen only speaks for `checkedId`; while the typed id has
  // moved past it, neither "free" nor "taken" is known yet.
  const checkingId = phase === "preview" && id.trim() !== (checkedId ?? "");
  const idTaken = Boolean(inspection && !inspection.requestedIdAvailable);
  const missingFittings = inspection?.fittings.filter((f) => !f.present) ?? [];
  const missingSecrets = inspection?.secrets.filter((s) => !s.set) ?? [];

  return (
    <section className={styles.bay} aria-labelledby="transfer-import-title" data-testid="transfer-import">
      <div className={styles.bayHead}>
        <p className={styles.bayKicker}>Import</p>
        <h3 className={styles.bayTitle} id="transfer-import-title">
          Bring a composition in
        </h3>
        <p className={styles.bayHint}>
          Drop a <code>.garrison.json</code> bundle. It lands as a new composition - an import never
          overwrites one that is already here.
        </p>
      </div>
      <div className={styles.bayBody}>
        {phase === "empty" || phase === "reading" ? (
          <>
            <div
              className={clsx(styles.drop, dragging && styles.dropActive)}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                const file = event.dataTransfer.files?.[0];
                if (file) void acceptFile(file);
              }}
              data-testid="import-dropzone"
            >
              <span className={styles.dropTitle}>
                {phase === "reading" ? "Reading bundle…" : "Drop a composition bundle"}
              </span>
              <p className={styles.dropHint}>
                A <code>.garrison.json</code> exported from any Garrison.
              </p>
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.ghostBtn}
                  onClick={() => fileInputRef.current?.click()}
                  disabled={phase === "reading"}
                  data-testid="import-choose"
                >
                  Choose file
                </button>
                <button
                  type="button"
                  className={styles.linkBtn}
                  onClick={() => setPasteOpen((open) => !open)}
                  data-testid="import-paste-toggle"
                >
                  {pasteOpen ? "hide paste box" : "or paste JSON"}
                </button>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                className={styles.hiddenInput}
                aria-label="Composition bundle file"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void acceptFile(file);
                }}
              />
            </div>
            {pasteOpen ? (
              <div className={styles.group}>
                <label className={styles.groupLabel} htmlFor="import-paste">
                  Bundle JSON
                </label>
                <textarea
                  id="import-paste"
                  className={styles.pasteArea}
                  value={pasteText}
                  spellCheck={false}
                  placeholder='{ "kind": "garrison.composition.bundle", … }'
                  onChange={(event) => setPasteText(event.target.value)}
                  data-testid="import-paste"
                />
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.ghostBtn}
                    disabled={!pasteText.trim() || phase === "reading"}
                    onClick={() => void accept(pasteText)}
                    data-testid="import-paste-read"
                  >
                    Read pasted bundle
                  </button>
                </div>
              </div>
            ) : null}
          </>
        ) : null}

        {error ? (
          <div className={clsx(styles.notice, styles.noticeAlarm)} role="alert" data-testid="import-error">
            <span className={styles.noticeGlyph}>!</span>
            <div className={styles.noticeBody}>
              <h5>That did not work</h5>
              <p>{error}</p>
            </div>
          </div>
        ) : null}

        {phase === "done" && imported ? (
          <>
            <div className={clsx(styles.notice, styles.noticeOk)} role="status" data-testid="import-done">
              <span className={styles.noticeGlyph}>+</span>
              <div className={styles.noticeBody}>
                <h5>Imported {imported.name}</h5>
                <p>
                  It is now a composition on this machine (<code>{imported.id}</code>). Activating it
                  stops the current operative and starts this one.
                </p>
              </div>
            </div>
            {missingFittings.length > 0 || missingSecrets.length > 0 ? (
              <div className={clsx(styles.notice, styles.noticeWarn)} role="status">
                <span className={styles.noticeGlyph}>!</span>
                <div className={styles.noticeBody}>
                  <h5>Before it will run</h5>
                  <ul>
                    {missingFittings.length > 0 ? (
                      <li>
                        Install or unstation {missingFittings.map((f) => f.id).join(", ")} - not in this
                        machine&apos;s registry.
                      </li>
                    ) : null}
                    {missingSecrets.length > 0 ? (
                      <li>Set {missingSecrets.map((s) => s.key).join(", ")} in Vault.</li>
                    ) : null}
                  </ul>
                </div>
              </div>
            ) : null}
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.primaryBtn}
                onClick={() => void activate()}
                disabled={switching}
                data-testid="import-activate"
              >
                {switching ? "Switching…" : "Make it active"}
              </button>
              <a
                className={styles.ghostBtn}
                href={`/muster?composition=${encodeURIComponent(imported.id)}`}
              >
                Open it
              </a>
              <button type="button" className={styles.linkBtn} onClick={reset}>
                import another
              </button>
            </div>
          </>
        ) : null}

        {(phase === "preview" || phase === "importing") && inspection ? (
          <>
            <div className={styles.stats} data-testid="import-stats">
              <span className={styles.statStrong}>{inspection.composition.name}</span>
              <span>·</span>
              <span>
                <span className={styles.statStrong}>{inspection.fittings.length}</span> fittings
              </span>
              <span>·</span>
              <span>
                <span className={styles.statStrong}>{inspection.duties}</span> duties
              </span>
              <span>·</span>
              <span>
                <span className={styles.statStrong}>{inspection.targets}</span> targets
              </span>
              <span>·</span>
              <span>
                <span className={styles.statStrong}>{inspection.files.length}</span> files
              </span>
              {inspection.exportedAt ? (
                <>
                  <span>·</span>
                  <span>exported {new Date(inspection.exportedAt).toLocaleDateString()}</span>
                </>
              ) : null}
            </div>

            {blocked ? (
              <div className={clsx(styles.notice, styles.noticeAlarm)} role="alert">
                <span className={styles.noticeGlyph}>!</span>
                <div className={styles.noticeBody}>
                  <h5>This bundle cannot be imported</h5>
                  <ul>
                    {inspection.errors.map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : null}

            <div className={styles.fields}>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="import-name">
                  Name
                </label>
                <input
                  id="import-name"
                  className={styles.input}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={phase === "importing"}
                  data-testid="import-name"
                />
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="import-id">
                  Id
                </label>
                <input
                  id="import-id"
                  className={styles.input}
                  value={id}
                  spellCheck={false}
                  onChange={(event) => setId(event.target.value)}
                  disabled={phase === "importing"}
                  data-testid="import-id"
                />
                <span
                  className={clsx(styles.fieldNote, idTaken && !checkingId && styles.fieldNoteWarn)}
                  data-testid="import-id-note"
                >
                  {checkingId
                    ? "checking…"
                    : idTaken
                      ? `"${id.trim()}" is taken - ${inspection.suggestedId} is free`
                      : "the directory under compositions/"}
                </span>
              </div>
            </div>

            {missingFittings.length > 0 ? (
              <div className={styles.group}>
                <p className={styles.groupLabel}>
                  Fittings ({inspection.fittings.length - missingFittings.length} of{" "}
                  {inspection.fittings.length} available here)
                </p>
                <ul className={styles.plainList}>
                  {inspection.fittings.map((fitting) => (
                    <li className={styles.reqRow} key={fitting.id}>
                      <span
                        className={clsx(styles.reqMark, fitting.present ? styles.markOk : styles.markMissing)}
                      >
                        {fitting.present ? "+" : "!"}
                      </span>
                      <span className={styles.reqName}>{fitting.id}</span>
                      <span className={styles.reqNote}>
                        {fitting.present ? fitting.faculty : "not installed"}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {missingSecrets.length > 0 ? (
              <div className={styles.group}>
                <p className={styles.groupLabel}>Vault keys not set here ({missingSecrets.length})</p>
                <ul className={styles.plainList}>
                  {missingSecrets.map((secret) => (
                    <li className={styles.reqRow} key={secret.key}>
                      <span className={clsx(styles.reqMark, styles.markMissing)}>!</span>
                      <span className={styles.reqName}>{secret.key}</span>
                      <span className={styles.reqNote}>add in Vault</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {inspection.warnings.length > 0 && !blocked ? (
              <div className={clsx(styles.notice, styles.noticeWarn)} role="status">
                <span className={styles.noticeGlyph}>!</span>
                <div className={styles.noticeBody}>
                  <h5>Imports, but needs attention</h5>
                  <ul>
                    {inspection.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : null}

            <div className={styles.group}>
              <p className={styles.groupLabel}>Files it will write ({inspection.files.length})</p>
              {inspection.files.length === 0 ? (
                <div className={styles.state}>The manifest alone - no authored files travelled.</div>
              ) : (
                <ul className={styles.fileList}>
                  {inspection.files.map((file) => (
                    <li className={styles.fileRow} key={file.path}>
                      <span className={styles.filePath}>{file.path}</span>
                      <span className={styles.fileMeta}>
                        {file.label} · {formatBytes(file.bytes)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className={styles.actions}>
              <button
                type="button"
                className={styles.primaryBtn}
                onClick={() => void doImport()}
                disabled={blocked || idTaken || checkingId || !id.trim() || phase === "importing"}
                data-testid="import-submit"
              >
                {phase === "importing" ? "Importing…" : "Import composition"}
              </button>
              <button
                type="button"
                className={styles.ghostBtn}
                onClick={reset}
                disabled={phase === "importing"}
              >
                Cancel
              </button>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}

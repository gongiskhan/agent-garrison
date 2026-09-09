import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Sheet } from "../../../fittings/seed/kanban-loop/ui/sheet";
import { DateTimePicker } from "../../../fittings/seed/kanban-loop/ui/date-picker";
import { PushNotice } from "./push-notice";

type Inference = { title: string; description: string; messageIds: string[]; confidence: number; windowCount: number; boundaryApplied: boolean; fallbackUsed: boolean };
type Action = "todo" | "start" | "schedule";
type Toast = { title?: string; cardUrl?: string; warning?: string; error?: string };
export function nativeCardHost() {
  if (typeof window === "undefined") return false;
  const bridge = (window as Window & { Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string } }).Capacitor;
  return bridge?.isNativePlatform?.() === true || ["ios", "android"].includes(bridge?.getPlatform?.() || "");
}
async function post(path: string, body: unknown, signal?: AbortSignal) {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

export function ZecaCardControl({ conversationId, project, projects, hasMessages }: {
  conversationId: string; project?: string | null; projects: string[]; hasMessages: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [inference, setInference] = useState<Inference | null>(null);
  const [windowSize, setWindowSize] = useState(10);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState(project || "");
  const [action, setAction] = useState<Action>("todo");
  const [scheduledAt, setScheduledAt] = useState("");
  const [titleEdited, setTitleEdited] = useState(false);
  const [descriptionEdited, setDescriptionEdited] = useState(false);
  const [validation, setValidation] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState<Toast | null>(null);
  const pending = useRef<AbortController | null>(null);
  const close = useCallback(() => { if (!creating) { pending.current?.abort(); setOpen(false); } }, [creating]);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    if (!toast || toast.error) return;
    const timer = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(timer);
  }, [toast]);
  async function infer(size: number) {
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    setLoading(true); setError(""); setWindowSize(size);
    try {
      const result: Inference = await post("/api/cards/from-zeca/infer", { conversationId, windowSize: size }, controller.signal);
      if (controller.signal.aborted) return;
      setInference(result); setTitle(result.title); setDescription(result.description);
      setTitleEdited(false); setDescriptionEdited(false); setValidation(!result.description.trim());
    } catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Could not read the conversation."); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }
  function begin() {
    setOpen(true); setToast(null); setProjectId(project || ""); setAction("todo"); setScheduledAt(""); setValidation(false); setInference(null);
    void infer(10);
  }
  async function create(event: React.FormEvent) {
    event.preventDefault(); setValidation(true);
    if (!inference || !title.trim() || !description.trim() || !projectId || (action === "schedule" && !Number.isFinite(Date.parse(scheduledAt)))) return;
    setCreating(true);
    try {
      const result = await post("/api/cards/from-zeca", { conversationId, title, description, projectId, messageIds: inference.messageIds,
        windowSize, confidence: inference.confidence, fallbackUsed: inference.fallbackUsed, titleEdited, descriptionEdited, action,
        ...(action === "schedule" ? { scheduledAt: new Date(scheduledAt).toISOString() } : {}) });
      setOpen(false); setToast({ title, cardUrl: result.cardUrl, warning: result.warning });
    } catch (err) { setOpen(false); setToast({ error: err instanceof Error ? err.message : "Please try again." }); }
    finally { setCreating(false); }
  }
  const titleError = validation && !title.trim(), descriptionError = validation && !description.trim(), projectError = validation && !projectId;
  const scheduleError = validation && action === "schedule" && !Number.isFinite(Date.parse(scheduledAt));
  return <>
    <button type="button" className="wc-create-card" title="Create card" aria-label="Create card" disabled={!hasMessages} onClick={begin}>
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="2" width="14" height="16" rx="2" /><path d="M6 6h8M10 9v6M7 12h6" /></svg>
    </button>
    <details className="wc-card-overflow"><summary aria-label="Conversation actions">•••</summary><button type="button" disabled={!hasMessages} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); begin(); }}>Create card</button></details>
    {open && createPortal(<Sheet title="Create a card from this conversation" onClose={close} className="zeca-card-sheet">
      <form onSubmit={(event) => { void create(event); }}>
        {loading ? <><p className="zc-muted" role="status">Reading the last messages…</p><div className="zc-skeleton" /><div className="zc-skeleton description" /></> : <>
          {inference && <p className="zc-window zc-muted">{inference.boundaryApplied ? `Drawn from the ${inference.windowCount} messages since the last card` : `Drawn from the last ${inference.windowCount} messages`}{windowSize < 50 && <> <button className="zc-link" type="button" onClick={() => { void infer(windowSize + 10); }}>Include earlier messages</button></>}</p>}
          {error && <p role="alert" className="zc-error">{error} <button type="button" onClick={() => { void infer(windowSize); }}>Retry</button></p>}
          {inference?.fallbackUsed && <p role="status" className="zc-banner">Couldn't summarise, showing the last messages instead.</p>}
          <label htmlFor="zc-title">Title</label><input autoComplete="off" id="zc-title" value={title} aria-invalid={titleError} aria-describedby={titleError ? "zc-title-error" : undefined} onChange={(event) => { setTitle(event.target.value); setTitleEdited(true); }} />
          {titleError && <p id="zc-title-error" className="zc-error">Give the card a title.</p>}
          <label htmlFor="zc-description">Description</label><textarea id="zc-description" value={description} aria-invalid={descriptionError} aria-describedby={descriptionError ? "zc-description-error" : undefined} onChange={(event) => { setDescription(event.target.value); setDescriptionEdited(true); }} />
          {descriptionError && <p id="zc-description-error" className="zc-error">Give the card a description.</p>}
        </>}
        <label htmlFor="zc-project">Project</label><select id="zc-project" value={projectId} aria-invalid={projectError} aria-describedby={projectError ? "zc-project-error" : undefined} onChange={(event) => setProjectId(event.target.value)}><option value="">Choose a project</option>{[...new Set([...projects, ...(project ? [project] : [])])].map((item) => <option key={item} value={item}>{item}</option>)}</select>
        {projectError && <p id="zc-project-error" className="zc-error">Choose a project.</p>}
        <fieldset><legend>What should happen?</legend><div className="zc-actions">{([["todo", "Add to To do"], ["start", "Start now"], ["schedule", "Schedule"]] as const).map(([value, label]) => <label key={value}><input type="radio" name="zc-action" value={value} checked={action === value} onChange={() => setAction(value)} />{label}</label>)}</div></fieldset>
        <p className="zc-muted">{action === "todo" ? "The card goes to To do. You can start it from the board later." : action === "start" ? "The card starts right away with the board's default route." : "Pick when the card should start."}</p>
        {action === "schedule" && <><DateTimePicker id="zc-schedule" label="Scheduled time" value={scheduledAt} onChange={setScheduledAt} />{scheduleError && <p className="zc-error">Pick a time.</p>}</>}
        <footer className="zc-footer"><button type="button" disabled={creating} onClick={close}>Cancel</button><button type="submit" className="zc-primary" disabled={loading || creating || !inference}>{creating ? "Creating…" : "Create card"}</button></footer>
      </form>
    </Sheet>, document.body)}
    {toast && createPortal(<PushNotice kind="toast" onDismiss={() => setToast(null)} text={toast.error ? <>Could not create the card. {toast.error} <button type="button" className="zc-link" onClick={() => { setToast(null); setOpen(true); }}>Retry</button></> : <>Card created: {toast.title}{toast.warning ? `. ${toast.warning}` : ""} <a href={toast.cardUrl}>Open card</a></>} />, document.body)}
  </>;
}

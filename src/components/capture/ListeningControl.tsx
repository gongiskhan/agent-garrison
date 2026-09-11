"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { nativeListening, type DeviceListeningState } from "@/lib/native-bridge";
import { listeningBadge, listeningCopy, ListeningHold, STOP_HOLD_MS } from "./listening-model";
import { changeListening, useListening } from "./use-listening";
import styles from "./ListeningControl.module.css";

export function ListeningRow({ state, onIntent, readOnly = false }: { state: DeviceListeningState; onIntent: (intent: "off" | "listening") => void; readOnly?: boolean }) {
  const copy = listeningCopy(state);
  const hold = useRef(new ListeningHold());
  const suppressClick = useRef(false);
  const [holding, setHolding] = useState(false);
  const [tooltip, setTooltip] = useState(false);
  const tooltipTimer = useRef<ReturnType<typeof setTimeout>>();
  const stop = copy.button === "Hold to stop";
  const cancel = () => { hold.current.cancel(); setHolding(false); };
  useEffect(() => {
    const blur = () => cancel();
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", blur);
    return () => { hold.current.cancel(); clearTimeout(tooltipTimer.current); window.removeEventListener("blur", blur); document.removeEventListener("visibilitychange", blur); };
  }, []);
  useEffect(() => { cancel(); }, [state.actual]);
  const begin = () => {
    if (!stop || readOnly) return;
    suppressClick.current = false; setTooltip(false); setHolding(true);
    hold.current.start(() => { suppressClick.current = true; setHolding(false); void nativeListening.haptic().catch(() => undefined); onIntent("off"); });
  };
  return <div className={styles.row} data-testid={`listening-${state.source}`} data-actual={state.actual}>
    <span className={`${styles.dot} ${styles[copy.tone]}`} aria-hidden />
    <div className={styles.copy} aria-live="polite"><strong>{copy.label}</strong>
      {!readOnly && state.actual === "failed" && state.reason === "permission_denied"
        ? <button type="button" className={styles.settings} onClick={() => void nativeListening.openSettings()}>{copy.sub}</button>
        : <span>{copy.sub}</span>}
    </div>
    {!readOnly && <div className={styles.action}>
      <button type="button" className={`btn small ${styles.button}`} disabled={copy.disabled}
        aria-label={copy.button} style={{ "--hold-ms": `${STOP_HOLD_MS}ms` } as React.CSSProperties}
        onPointerDown={e => { if (e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); begin(); }}
        onPointerUp={cancel} onPointerCancel={cancel} onLostPointerCapture={cancel} onContextMenu={e => e.preventDefault()}
        onKeyDown={e => { if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); begin(); } }}
        onKeyUp={e => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); if (suppressClick.current) { suppressClick.current = false; cancel(); return; } if (!stop) onIntent("listening"); cancel(); } }}
        onClick={() => {
          if (suppressClick.current) { suppressClick.current = false; return; }
          if (!stop) { onIntent("listening"); return; }
          if (hold.current.completed) return;
          setTooltip(true); clearTimeout(tooltipTimer.current); tooltipTimer.current = setTimeout(() => setTooltip(false), 2000);
        }}>
        {copy.disabled ? <span className={styles.spinner} aria-hidden /> : copy.button}
        {stop && <svg className={styles.ring} viewBox="0 0 40 40" aria-hidden><circle className={holding ? styles.filling : ""} cx="20" cy="20" r="18" pathLength="100" /></svg>}
      </button>
      {tooltip && <span role="tooltip" className={styles.tooltip}>Hold to stop</span>}
    </div>}
  </div>;
}
export function ListeningControl() {
  const { snapshot, native, error } = useListening();
  if (!native) return null;
  const records = snapshot.records.filter(r => r.source === "phone" || snapshot.paired);
  return <section className={styles.controls} aria-label="Listening" data-testid="listening-control">
    {records.map(state => <ListeningRow key={state.source} state={state} onIntent={intent => void changeListening(state.source, intent)} />)}
    {error && <p role="alert" className={styles.error}>{error}</p>}
  </section>;
}
export function ListeningBadgeView({ records }: { records: DeviceListeningState[] }) {
  const badge = listeningBadge(records);
  if (!badge) return null;
  return <Link href="/capture" className={`${styles.badge} ${styles[badge.tone]}`} data-testid="listening-badge"><span className={styles.dot} aria-hidden />{badge.label}</Link>;
}
export function ListeningBadge() {
  const { snapshot, native } = useListening();
  return native ? <ListeningBadgeView records={snapshot.records} /> : null;
}
export function ListeningToast() {
  const { notice, native } = useListening();
  return native && notice ? <div role="status" className={styles.toast}>{notice}</div> : null;
}

export function ListeningReadOnly() {
  const [records, setRecords] = useState<DeviceListeningState[]>([]);
  useEffect(() => {
    const events = new EventSource("/api/voice/listening/events");
    events.onmessage = event => {
      try {
        const record = JSON.parse(event.data);
        if (record.type !== "listening.state") return;
        setRecords(previous => [...previous.filter(r => r.device_id !== record.device_id || r.source !== record.source), record]);
      } catch { /* Ignore malformed events; the next full record repairs the view. */ }
    };
    return () => events.close();
  }, []);
  return <section aria-label="Device listening states">{records.map(record => <div key={`${record.device_id}/${record.source}`}><small>{record.device_name} / {record.source}</small><ListeningRow state={record} onIntent={() => undefined} readOnly /></div>)}</section>;
}

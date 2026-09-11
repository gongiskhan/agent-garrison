"use client";
import { useEffect, useSyncExternalStore } from "react";
import { isNativeApp, nativeListening, type DeviceListeningState, type ListeningSnapshot } from "@/lib/native-bridge";

const empty: ListeningSnapshot = { device_id: "", records: [], paired: false };
let snapshot = empty;
let error: string | null = null;
let notice: string | null = null;
let view: { snapshot: ListeningSnapshot; error: string | null; notice: string | null; native: boolean } = { snapshot, error, notice, native: false };
const subscribers = new Set<() => void>();
const optimistic = new Map<string, { before: string; actual: "off" | "starting"; timer: ReturnType<typeof setTimeout> }>();
let connected = false;
function publish() {
  view = { snapshot: { ...snapshot, records: snapshot.records.map(r => optimistic.has(r.source) ? { ...r, actual: optimistic.get(r.source)!.actual } : r) }, error, notice, native: isNativeApp() };
  subscribers.forEach(fn => fn());
}
function receive(next: ListeningSnapshot) {
  for (const record of next.records) {
    const pending = optimistic.get(record.source);
    if (pending && (record.actual_changed_at !== pending.before || record.actual === pending.actual)) { clearTimeout(pending.timer); optimistic.delete(record.source); }
  }
  snapshot = next; publish();
}
async function connect() {
  if (connected || !isNativeApp()) return;
  connected = true;
  let received = false;
  try {
    await nativeListening.onState(next => { received = true; receive(next); });
    await nativeListening.onNotice(value => {
      notice = value.message; publish();
      setTimeout(() => { if (notice === value.message) { notice = null; publish(); } }, 3000);
    });
    const current = await nativeListening.state();
    if (!received) receive(current);
  } catch (err) { error = err instanceof Error ? err.message : String(err); publish(); }
}
export async function changeListening(source: DeviceListeningState["source"], intent: DeviceListeningState["intent"]) {
  const row = snapshot.records.find(r => r.source === source);
  if (!row) return;
  error = null;
  const previous = optimistic.get(source); if (previous) clearTimeout(previous.timer);
  optimistic.set(source, { before: row.actual_changed_at, actual: intent === "off" ? "off" : "starting", timer: setTimeout(() => {
    optimistic.delete(source); error = "Listening state has not reached Garrison yet."; publish();
  }, 15000) });
  publish();
  try { await nativeListening.intent(source, intent); }
  catch (err) { const entry = optimistic.get(source); if (entry) clearTimeout(entry.timer); optimistic.delete(source); error = err instanceof Error ? err.message : String(err); publish(); }
}
const serverView = { snapshot: empty, error: null, notice: null, native: false };
export function useListening() {
  const state = useSyncExternalStore(fn => { subscribers.add(fn); return () => { subscribers.delete(fn); }; }, () => view, () => serverView);
  useEffect(() => { void connect(); }, []);
  return state;
}

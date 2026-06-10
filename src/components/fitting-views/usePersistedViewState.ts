"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_INSTANCE_ID } from "@/lib/view-instances";

// The client side of the serialize()/hydrate() contract for embedded views.
// A view opts in by holding its rememberable state through this hook:
//
//   const [state, setState, { loaded }] = usePersistedViewState<MyShape>(
//     "artifact-store", "list", initial
//   );
//
// hydrate = the persisted blob arrives as `state` once `loaded` flips true;
// serialize = every setState schedules a debounced PUT (~500ms trailing) to
// /api/view-state — persistence is continuous, there is no save action.

const DEBOUNCE_MS = 500;

export interface PersistedViewStateMeta {
  loaded: boolean;
}

export function usePersistedViewState<T>(
  fittingId: string,
  initial: T,
  instanceId: string = DEFAULT_INSTANCE_ID
): [T, (next: T | ((prev: T) => T)) => void, PersistedViewStateMeta] {
  const [state, setStateRaw] = useState<T>(initial);
  const [loaded, setLoaded] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRef = useRef<T>(initial);

  useEffect(() => {
    let cancelled = false;
    fetch(
      `/api/view-state?fitting=${encodeURIComponent(fittingId)}&instance=${encodeURIComponent(instanceId)}`,
      { cache: "no-store" }
    )
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { exists?: boolean; envelope?: { state?: T } } | null) => {
        if (cancelled) return;
        if (body?.exists && body.envelope && "state" in body.envelope) {
          latestRef.current = body.envelope.state as T;
          setStateRaw(body.envelope.state as T);
        }
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [fittingId, instanceId]);

  const persist = useCallback(
    (value: T) => {
      void fetch("/api/view-state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fitting: fittingId, instance: instanceId, state: value })
      }).catch(() => {
        // Best-effort: the next change retries; rehydrate falls back to the
        // last successful write.
      });
    },
    [fittingId, instanceId]
  );

  const setState = useCallback(
    (next: T | ((prev: T) => T)) => {
      setStateRaw((prev) => {
        const value = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        latestRef.current = value;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          persist(latestRef.current);
        }, DEBOUNCE_MS);
        return value;
      });
    },
    [persist]
  );

  // Flush a pending debounced write on unmount so navigation away never
  // drops the last change.
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        persist(latestRef.current);
      }
    };
  }, [persist]);

  return [state, setState, { loaded }];
}

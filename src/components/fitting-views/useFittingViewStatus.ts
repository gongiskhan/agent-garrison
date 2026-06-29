"use client";

import { useCallback, useEffect, useState } from "react";

export interface FittingViewStatus {
  fittingId: string;
  port: number;
  url: string;
  tailnetUrl: string | null;
  pid: number | null;
  startedAt: string | null;
  healthy: boolean | null;
}

export interface UseFittingViewStatusResult {
  entries: FittingViewStatus[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

interface DiscoveredView {
  fittingId: string;
  port: number;
  url: string;
  tailnetUrl: string | null;
  pid: number | null;
  startedAt: string | null;
  healthy: boolean;
}

export function useFittingViewStatus(pollMs = 15000): UseFittingViewStatusResult {
  const [entries, setEntries] = useState<FittingViewStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/fittings/views");
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError((data && data.error) || `HTTP ${res.status}`);
        return;
      }
      // Health is probed server-side — own-port Fittings don't emit CORS
      // headers, so a browser-side probe always fails.
      const data = (await res.json()) as { views: DiscoveredView[] };
      setEntries(data.views);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    if (pollMs <= 0) return;
    const id = setInterval(refresh, pollMs);
    return () => clearInterval(id);
  }, [refresh, pollMs]);

  return { entries, loading, error, refresh };
}

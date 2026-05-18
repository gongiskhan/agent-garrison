"use client";

import { useCallback, useEffect, useState } from "react";

export interface ToolWithHealth {
  fittingId: string;
  port: number;
  url: string;
  pid: number | null;
  startedAt: string | null;
  healthy: boolean | null; // null = unknown / checking
}

export interface UseToolDiscoveryResult {
  entries: ToolWithHealth[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

interface DiscoveredTool {
  fittingId: string;
  port: number;
  url: string;
  pid: number | null;
  startedAt: string | null;
  healthy: boolean;
}

export function useToolDiscovery(pollMs = 15000): UseToolDiscoveryResult {
  const [entries, setEntries] = useState<ToolWithHealth[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/tools/discover");
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError((data && data.error) || `HTTP ${res.status}`);
        return;
      }
      // Health is probed server-side (the tool ports don't emit CORS headers,
      // so a browser-side probe always fails).
      const data = (await res.json()) as { tools: DiscoveredTool[] };
      setEntries(data.tools);
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

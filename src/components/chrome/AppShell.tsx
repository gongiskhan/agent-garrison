"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from "react";
import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { FittingEditor } from "@/components/FittingEditor";
import type {
  Composition,
  FittingSelectionMap,
  GlobalConfig,
  LibraryEntry,
  RunnerState,
  VaultSecret
} from "@/lib/types";

export interface AppShellState {
  // data
  composition: Composition | null;
  library: LibraryEntry[];
  runnerState: RunnerState | null;
  // vault
  vaultUnlocked: boolean;
  vaultNeedsPassword: boolean;
  vaultDevMode: boolean;
  secrets: VaultSecret[];
  // ui state
  busy: string | null;
  error: string | null;
  // mutators
  refreshAll: () => Promise<void>;
  refreshRunnerState: () => Promise<void>;
  saveComposition: (next: Partial<{
    name: string;
    selections: FittingSelectionMap;
    globalConfig: GlobalConfig;
  }>) => Promise<void>;
  runAction: (action: "up" | "down" | "verify" | "dev") => Promise<void>;
  unlockVault: (passphrase: string) => Promise<void>;
  setSecrets: (secrets: VaultSecret[]) => void;
  saveSecrets: () => Promise<void>;
  setError: (err: string | null) => void;
  // sidebar
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  // editor modal
  editingFitting: LibraryEntry | null;
  openFittingEditor: (entry: LibraryEntry) => void;
  closeFittingEditor: () => void;
}

const Ctx = createContext<AppShellState | null>(null);

export function useAppShell(): AppShellState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAppShell must be used inside <AppShell>");
  return ctx;
}

export function AppShell({ children }: { children: ReactNode }) {
  const [composition, setComposition] = useState<Composition | null>(null);
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [runnerState, setRunnerState] = useState<RunnerState | null>(null);
  const [vaultUnlocked, setVaultUnlocked] = useState(false);
  const [vaultNeedsPassword, setVaultNeedsPassword] = useState(false);
  const [vaultDevMode, setVaultDevMode] = useState(false);
  const [secrets, setSecrets] = useState<VaultSecret[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingFitting, setEditingFitting] = useState<LibraryEntry | null>(null);
  // Auto-collapse sidebar on narrow viewports — at < 720px the 244px sidebar
  // dominates the available content area. Initial state matches the server
  // render (false) and we apply the narrow-viewport collapse in a
  // post-hydration effect to avoid hydration mismatches. Re-evaluated on
  // window resize.
  const NARROW_BREAKPOINT = 720;
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    function applyForViewport() {
      const narrow = window.innerWidth < NARROW_BREAKPOINT;
      if (narrow) {
        setSidebarCollapsed(true);
      } else {
        setSidebarCollapsed(localStorage.getItem("garrison.sidebar.collapsed") === "1");
      }
    }
    applyForViewport();
    window.addEventListener("resize", applyForViewport);
    return () => window.removeEventListener("resize", applyForViewport);
  }, []);
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      // Only persist the preference at desktop widths — at narrow widths,
      // the user toggling open is treated as a one-off overlay, not a saved pref.
      if (typeof window !== "undefined" && window.innerWidth >= NARROW_BREAKPOINT) {
        localStorage.setItem("garrison.sidebar.collapsed", next ? "1" : "0");
      }
      return next;
    });
  }, []);

  const refreshAll = useCallback(async () => {
    setError(null);
    try {
      const [libraryRes, compositionRes, vaultRes] = await Promise.all([
        fetch("/api/library"),
        fetch("/api/compositions"),
        fetch("/api/vault/secrets")
      ]);
      const [libraryData, compositionData, vaultData] = await Promise.all([
        libraryRes.json(),
        compositionRes.json(),
        vaultRes.json()
      ]);
      const allCompositions = (compositionData.compositions ?? []) as Composition[];
      const states = await Promise.all(
        allCompositions.map(async (c) => {
          try {
            const r = await fetch(`/api/runner/${c.id}/state`);
            const j = await r.json();
            return { id: c.id, status: j?.state?.status ?? "idle" };
          } catch {
            return { id: c.id, status: "idle" };
          }
        })
      );
      const running = states.find((s) => s.status === "running" || s.status === "starting");
      const next =
        (running && allCompositions.find((c) => c.id === running.id)) ??
        (allCompositions[0] as Composition | undefined) ??
        null;
      setLibrary(libraryData.library ?? []);
      setComposition(next ?? null);
      setVaultUnlocked(Boolean(vaultData.unlocked));
      setVaultNeedsPassword(Boolean(vaultData.needsPassword));
      setVaultDevMode(Boolean(vaultData.devMode));
      setSecrets(vaultData.secrets ?? []);
      if (next?.id) {
        const stateRes = await fetch(`/api/runner/${next.id}/state`);
        const stateData = await stateRes.json();
        setRunnerState(stateData.state ?? null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  const refreshRunnerState = useCallback(async () => {
    if (!composition?.id) return;
    try {
      const res = await fetch(`/api/runner/${composition.id}/state`);
      const data = await res.json();
      setRunnerState(data.state ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [composition?.id]);

  const saveComposition = useCallback<AppShellState["saveComposition"]>(
    async (next) => {
      if (!composition) return;
      setBusy("save");
      setError(null);
      try {
        const res = await fetch(`/api/compositions/${composition.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: next.name ?? composition.name,
            selections: next.selections ?? composition.selections,
            globalConfig: next.globalConfig ?? composition.globalConfig
          })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? res.statusText);
        setComposition(data.composition as Composition);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [composition]
  );

  const runAction = useCallback<AppShellState["runAction"]>(
    async (action) => {
      if (!composition) return;
      setBusy(action);
      setError(null);
      try {
        const res = await fetch(`/api/runner/${composition.id}/${action}`, {
          method: "POST"
        });
        const data = await res.json();
        if (data.state) setRunnerState(data.state);
        await refreshRunnerState();
        if (!res.ok) throw new Error(data.error ?? res.statusText);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        await refreshRunnerState();
      } finally {
        setBusy(null);
      }
    },
    [composition, refreshRunnerState]
  );

  const unlockVault = useCallback<AppShellState["unlockVault"]>(
    async (passphrase) => {
      setBusy("vault");
      setError(null);
      try {
        const res = await fetch("/api/vault/unlock", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ passphrase })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? res.statusText);
        setVaultUnlocked(Boolean(data.unlocked));
        setVaultNeedsPassword(Boolean(data.needsPassword));
        setSecrets(data.secrets ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    []
  );

  const saveSecrets = useCallback<AppShellState["saveSecrets"]>(async () => {
    setBusy("secrets");
    setError(null);
    try {
      const res = await fetch("/api/vault/secrets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secrets })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      setSecrets(data.secrets ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [secrets]);

  const value = useMemo<AppShellState>(
    () => ({
      composition,
      library,
      runnerState,
      vaultUnlocked,
      vaultNeedsPassword,
      vaultDevMode,
      secrets,
      busy,
      error,
      refreshAll,
      refreshRunnerState,
      saveComposition,
      runAction,
      unlockVault,
      setSecrets,
      saveSecrets,
      setError,
      sidebarCollapsed,
      toggleSidebar,
      editingFitting,
      openFittingEditor: setEditingFitting,
      closeFittingEditor: () => setEditingFitting(null)
    }),
    [
      composition,
      library,
      runnerState,
      vaultUnlocked,
      vaultNeedsPassword,
      vaultDevMode,
      secrets,
      busy,
      error,
      refreshAll,
      refreshRunnerState,
      saveComposition,
      runAction,
      unlockVault,
      saveSecrets,
      sidebarCollapsed,
      toggleSidebar,
      editingFitting
    ]
  );

  return (
    <Ctx.Provider value={value}>
      <div
        className="app-shell"
        style={{ gridTemplateColumns: sidebarCollapsed ? "48px 1fr" : "244px 1fr" }}
      >
        <Sidebar />
        {children}
      </div>
      {editingFitting ? (
        <FittingEditor
          entry={editingFitting}
          onClose={() => setEditingFitting(null)}
        />
      ) : null}
    </Ctx.Provider>
  );
}

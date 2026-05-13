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
  const [secrets, setSecrets] = useState<VaultSecret[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingFitting, setEditingFitting] = useState<LibraryEntry | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("garrison.sidebar.collapsed") === "1";
  });
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("garrison.sidebar.collapsed", next ? "1" : "0");
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
      const next = compositionData.compositions[0] as Composition;
      setLibrary(libraryData.library ?? []);
      setComposition(next);
      setVaultUnlocked(Boolean(vaultData.unlocked));
      setVaultNeedsPassword(Boolean(vaultData.needsPassword));
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

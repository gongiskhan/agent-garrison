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
import { TourEngine } from "@/components/tours/TourEngine";
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
  compositions: Composition[];
  library: LibraryEntry[];
  runnerState: RunnerState | null;
  // active-composition switching (WS4 / D6) - rendered by the Sidebar footer
  activePointer: string | null;
  activeExternal: boolean;
  switching: boolean;
  switchError: string | null;
  switchTo: (target: string) => void;
  dismissSwitchError: () => void;
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
  refreshLibrary: () => Promise<void>;
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
  // < NARROW_BREAKPOINT - the expanded sidebar renders as an overlay drawer
  narrowViewport: boolean;
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
  const [compositions, setCompositions] = useState<Composition[]>([]);
  const [activePointer, setActivePointer] = useState<string | null>(null);
  const [activeExternal, setActiveExternal] = useState<boolean>(false);
  const [switching, setSwitching] = useState<boolean>(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
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
  // Presence heartbeat (GARRISON-UNIFY-V1 S14, D34): POST /api/power/heartbeat
  // every 60s, ONLY while the page is visible AND has seen user input within
  // 5 minutes. Self-contained by design (no shared components — composition by
  // URL); the relay 204s silently when the Power fitting is absent.
  useEffect(() => {
    if (typeof window === "undefined") return;
    let lastInput = Date.now();
    const markInput = () => { lastInput = Date.now(); };
    window.addEventListener("pointerdown", markInput, { passive: true });
    window.addEventListener("keydown", markInput, { passive: true });
    const beat = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastInput > 5 * 60_000) return;
      void fetch("/api/power/heartbeat", { method: "POST" }).catch(() => {});
    };
    const timer = window.setInterval(beat, 60_000);
    beat();
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pointerdown", markInput);
      window.removeEventListener("keydown", markInput);
    };
  }, []);

  // post-hydration effect to avoid hydration mismatches. Re-evaluated on
  // window resize.
  const NARROW_BREAKPOINT = 720;
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [narrowViewport, setNarrowViewport] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    // Only touch the collapse state when the viewport CROSSES the breakpoint.
    // Mobile browsers fire resize on URL-bar / keyboard height changes; those
    // must not snap-close a drawer the user just opened.
    let prevNarrow: boolean | null = null;
    function applyForViewport() {
      const narrow = window.innerWidth < NARROW_BREAKPOINT;
      setNarrowViewport(narrow);
      if (narrow === prevNarrow) return;
      prevNarrow = narrow;
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
      const [libraryRes, compositionRes, vaultRes, activeRes] = await Promise.all([
        fetch("/api/library"),
        fetch("/api/compositions"),
        fetch("/api/vault/secrets"),
        fetch("/api/composition/active")
      ]);
      const [libraryData, compositionData, vaultData, activeData] = await Promise.all([
        libraryRes.json(),
        compositionRes.json(),
        vaultRes.json(),
        activeRes.ok ? activeRes.json() : Promise.resolve(null)
      ]);
      const allCompositions = (compositionData.compositions ?? []) as Composition[];
      const activePointerVal: string | null =
        typeof activeData?.pointer === "string" ? activeData.pointer : null;
      const activeId: string | null = typeof activeData?.id === "string" ? activeData.id : null;
      // An external pointer's id is a bare basename that may COLLIDE with an
      // in-repo composition id; never treat it as that in-repo composition.
      const activeExternalVal = Boolean(activeData?.external);
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
      // Active pointer wins (WS4 / D6); fall back to the legacy running-else-first
      // heuristic for back-compat when no pointer resolves to a listed composition.
      const next =
        (activeId && !activeExternalVal ? allCompositions.find((c) => c.id === activeId) : undefined) ??
        (running && allCompositions.find((c) => c.id === running.id)) ??
        (allCompositions[0] as Composition | undefined) ??
        null;
      setLibrary(libraryData.library ?? []);
      setCompositions(allCompositions);
      setActivePointer(activePointerVal);
      setActiveExternal(activeExternalVal);
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

  // Refetch just the Fitting registry — used after a Clone so the new local
  // Fitting appears in its Faculty without re-selecting the active composition.
  const refreshLibrary = useCallback(async () => {
    try {
      const res = await fetch("/api/library");
      const data = await res.json();
      setLibrary(data.library ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

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

  // Poll the runner state so status pills track transitions live. Without this
  // the pill only updates when a runAction POST resolves — an in-tab Restart
  // holds that POST open for the whole up() (~2 min), so STARTING/VERIFYING
  // were never visible and an up/down triggered from another surface never
  // showed at all. Cheap local GET; skipped while the tab is hidden.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refreshRunnerState();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [refreshRunnerState]);

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

  // Switch the active composition (WS4 / D6). Resolves the target server-side
  // FIRST; a resolver error (409) is surfaced inline WITHOUT changing the
  // selection (the controlled <select> snaps back to the current active id).
  const switchTo = useCallback(
    async (target: string) => {
      if (switching) return;
      setSwitching(true);
      setSwitchError(null);
      try {
        const res = await fetch("/api/composition/switch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setSwitchError(typeof data?.error === "string" ? data.error : res.statusText);
          return;
        }
        await refreshAll();
      } catch (err) {
        setSwitchError(err instanceof Error ? err.message : String(err));
      } finally {
        setSwitching(false);
      }
    },
    [switching, refreshAll]
  );

  const value = useMemo<AppShellState>(
    () => ({
      composition,
      compositions,
      library,
      runnerState,
      activePointer,
      activeExternal,
      switching,
      switchError,
      switchTo,
      dismissSwitchError: () => setSwitchError(null),
      vaultUnlocked,
      vaultNeedsPassword,
      vaultDevMode,
      secrets,
      busy,
      error,
      refreshAll,
      refreshLibrary,
      refreshRunnerState,
      saveComposition,
      runAction,
      unlockVault,
      setSecrets,
      saveSecrets,
      setError,
      sidebarCollapsed,
      toggleSidebar,
      narrowViewport,
      editingFitting,
      openFittingEditor: setEditingFitting,
      closeFittingEditor: () => setEditingFitting(null)
    }),
    [
      composition,
      compositions,
      library,
      runnerState,
      activePointer,
      activeExternal,
      switching,
      switchError,
      switchTo,
      vaultUnlocked,
      vaultNeedsPassword,
      vaultDevMode,
      secrets,
      busy,
      error,
      refreshAll,
      refreshLibrary,
      refreshRunnerState,
      saveComposition,
      runAction,
      unlockVault,
      saveSecrets,
      sidebarCollapsed,
      toggleSidebar,
      narrowViewport,
      editingFitting
    ]
  );

  return (
    <Ctx.Provider value={value}>
      <div
        className="app-shell"
        style={{
          // At narrow widths the expanded sidebar is a fixed overlay drawer
          // (out of flow), so the grid keeps the 48px rail column either way.
          gridTemplateColumns:
            sidebarCollapsed || narrowViewport ? "48px 1fr" : "244px 1fr"
        }}
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
      {/* WS6: the in-app tour engine — watches ?tour=<name>&mode= and overlays
          the demo/guided player on the current surface. */}
      <TourEngine />
    </Ctx.Provider>
  );
}

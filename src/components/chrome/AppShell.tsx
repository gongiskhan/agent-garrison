"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type { ReactNode } from "react";
import clsx from "clsx";
import { usePathname } from "next/navigation";
import { Sidebar } from "./Sidebar";
import { PushRouteListener } from "./PushRouteListener";
import { FittingEditor } from "@/components/FittingEditor";
import { TourEngine } from "@/components/tours/TourEngine";
import type {
  Composition,
  FittingSelectionMap,
  GlobalConfig,
  LibraryEntry,
  RunnerState,
  VaultSecretRow
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
  vaultKeySource: string;
  secrets: VaultSecretRow[];
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
  runAction: (action: "up" | "up-full" | "down" | "verify" | "dev") => Promise<void>;
  unlockVault: (passphrase?: string) => Promise<void>;
  setSecrets: (secrets: VaultSecretRow[]) => void;
  revealSecret: (key: string) => Promise<void>;
  saveSecrets: () => Promise<boolean>;
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
  // /embed/<id> renders a Fitting's own UI full-bleed, so shell-level floating
  // controls would overlay it. See the CompositionCreator render below.
  const pathname = usePathname() ?? "";
  const isEmbeddedView = pathname.startsWith("/embed/");
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
  const [vaultKeySource, setVaultKeySource] = useState("unavailable");
  const [secrets, setSecrets] = useState<VaultSecretRow[]>([]);
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
  // Persist across React Strict Mode's effect replay. A function-local sentinel
  // resets during the replay and can collapse the drawer immediately after the
  // user's first Expand tap.
  const previousNarrowRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    // Only touch the collapse state when the viewport CROSSES the breakpoint.
    // Mobile browsers fire resize on URL-bar / keyboard height changes; those
    // must not snap-close a drawer the user just opened.
    function applyForViewport() {
      const narrow = window.innerWidth < NARROW_BREAKPOINT;
      setNarrowViewport(narrow);
      if (narrow === previousNarrowRef.current) return;
      previousNarrowRef.current = narrow;
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
      setVaultKeySource(
        typeof vaultData.keySource === "string" ? vaultData.keySource : "unavailable"
      );
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

  // Keep the composition itself fresh too: the Muster standing panel (and any
  // other tab) writes selections through /api/muster/standing/* without going
  // through this provider, so without a refetch the sidebar Fittings menu kept
  // showing unfitted fittings until a full reload. Cheap local GET; only
  // re-renders when the on-disk content actually differs. Skipped while a
  // save/run action from THIS tab is in flight so a poll response can never
  // clobber an optimistic update mid-save.
  const busyRef = useRef<AppShellState["busy"]>(null);
  busyRef.current = busy;
  const refreshComposition = useCallback(async () => {
    if (!composition?.id || busyRef.current) return;
    try {
      const res = await fetch(`/api/compositions/${composition.id}`);
      if (!res.ok) return;
      const data = await res.json();
      const fresh = data.composition as Composition | undefined;
      if (!fresh || busyRef.current) return;
      setComposition((prev) => {
        // A late poll response for a DIFFERENT composition (the tab switched
        // while the GET was in flight) must be discarded, not installed —
        // installing it would revert the switch and wedge subsequent polls on
        // the old id.
        if (prev && prev.id !== fresh.id) return prev;
        return prev && JSON.stringify(prev) === JSON.stringify(fresh) ? prev : fresh;
      });
    } catch {
      // Poll refresh is best-effort; the next tick retries.
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
      void refreshComposition();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [refreshRunnerState, refreshComposition]);

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
        const endpoint = action === "up-full" ? "up" : action;
        const res = await fetch(`/api/runner/${composition.id}/${endpoint}`, {
          method: "POST",
          ...(action === "up-full"
            ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ full: true }) }
            : {})
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
          body: JSON.stringify({ passphrase: passphrase ?? "" })
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

  // Fetch ONE plaintext value on explicit user action. The list itself only
  // ever carries masks, so nothing reveals a credential by merely loading the
  // page. Every reveal is recorded in the vault audit log server-side.
  const revealSecret = useCallback<AppShellState["revealSecret"]>(async (key) => {
    setError(null);
    try {
      const res = await fetch("/api/vault/secrets/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      setSecrets((rows) =>
        rows.map((row) => (row.key === key ? { ...row, value: String(data.value ?? "") } : row))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const saveSecrets = useCallback<AppShellState["saveSecrets"]>(async () => {
    setBusy("secrets");
    setError(null);
    try {
      // Send `value` ONLY for rows the user actually typed into. A row that was
      // revealed but not edited, or never revealed at all, goes as {key} alone
      // and the server preserves what it already has — otherwise saving one new
      // secret would write every other row's mask over its real value.
      const payload = secrets.map((row) =>
        row.dirty ? { key: row.key, value: row.value ?? "" } : { key: row.key }
      );
      const res = await fetch("/api/vault/secrets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secrets: payload })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      setSecrets(data.secrets ?? []);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
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
        if (!res.ok || data?.ok !== true) {
          setSwitchError(typeof data?.error === "string" ? data.error : res.statusText);
          return;
        }
        // Composition-scoped pages own models outside AppShell. Remount the
        // current surface only after the clean switch succeeds, and discard an
        // explicit old composition query that would otherwise pin that model to
        // the source after reload.
        const nextUrl = new URL(window.location.href);
        nextUrl.searchParams.delete("composition");
        window.location.assign(`${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
      } catch (err) {
        setSwitchError(err instanceof Error ? err.message : String(err));
      } finally {
        setSwitching(false);
      }
    },
    [switching]
  );

  // Clone the active composition, then activate it through the SAME clean
  // switch path as the selector (resolve -> down -> pointer -> up). The clone is
  // complete before switch begins, so a launch failure still leaves a valid,
  // selectable composition that can be inspected and retried.
  const createAndSwitch = useCallback(
    async (name: string): Promise<boolean> => {
      if (switching || !composition || activeExternal) return false;
      setSwitching(true);
      setSwitchError(null);
      let createdId: string | null = null;
      try {
        const createRes = await fetch("/api/compositions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, sourceId: composition.id })
        });
        const created = await createRes.json().catch(() => ({}));
        if (!createRes.ok) {
          throw new Error(typeof created?.error === "string" ? created.error : createRes.statusText);
        }
        createdId = typeof created?.composition?.id === "string" ? created.composition.id : null;
        if (!createdId) throw new Error("composition clone returned no id");

        const switchRes = await fetch("/api/composition/switch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target: createdId })
        });
        const switched = await switchRes.json().catch(() => ({}));
        if (!switchRes.ok || switched?.ok !== true) {
          throw new Error(typeof switched?.error === "string" ? switched.error : switchRes.statusText);
        }
        // Muster owns composition-scoped model state outside AppShell. A shell
        // refresh alone would update the header while leaving that page model
        // bound to the source composition, so the next edit could mutate the
        // source. Remount the whole surface after the clean switch completes.
        window.location.assign("/muster");
        return true;
      } catch (err) {
        setSwitchError(err instanceof Error ? err.message : String(err));
        // If cloning succeeded but launch did not, refresh so the complete clone
        // still appears in the selector and can be retried.
        if (createdId) void refreshAll();
        return false;
      } finally {
        setSwitching(false);
      }
    },
    [activeExternal, composition, refreshAll, switching]
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
      vaultKeySource,
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
      revealSecret,
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
      vaultKeySource,
      secrets,
      busy,
      error,
      refreshAll,
      refreshLibrary,
      refreshRunnerState,
      saveComposition,
      runAction,
      unlockVault,
      revealSecret,
      saveSecrets,
      sidebarCollapsed,
      toggleSidebar,
      narrowViewport,
      editingFitting
    ]
  );

  return (
    <Ctx.Provider value={value}>
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <PushRouteListener />
      {/* At phone width an embedded Fitting view takes the whole screen: the
          52px rail would squeeze the iframe to ~340px and the view's own
          header would sit under the status bar. The embed page renders its own
          back bar instead (the drawer still opens from it). */}
      <div
        className={clsx(
          "app-shell",
          (sidebarCollapsed || narrowViewport) && "shell-rail",
          narrowViewport && isEmbeddedView && "shell-embed-full"
        )}
      >
        <Sidebar />
        <div className="shell-content">
          <span id="main-content" className="shell-main-anchor" tabIndex={-1} />
          {children}
        </div>
      </div>
      {error ? (
        <div className="shell-notice" role="alert" aria-live="assertive">
          <div>
            <span className="shell-notice-kicker">Command fault</span>
            <p>{error}</p>
          </div>
          <button type="button" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
      {/* The creator is `position: fixed` at top-right so it needs no
          per-route placement — but an /embed/<id> route renders a Fitting's own
          UI full-bleed from y=0, so the floating trigger lands on top of
          whatever that Fitting puts in ITS top-right (it was covering Drill's
          PROJECT selector). Embedded views are the Fitting's surface, not a
          Garrison page; composition creation stays one click away on every
          real route. */}
      {isEmbeddedView ? null : (
        <CompositionCreator
          activeName={composition?.name ?? composition?.id ?? null}
          disabled={switching || activeExternal || !composition}
          onCreate={createAndSwitch}
        />
      )}
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

// Creation remains a shell-level action because it clones the active
// composition before going through the same clean switch transaction as the
// Sidebar selector. The selector itself lives in Sidebar; keeping this component
// creation-only avoids two controls with the same composition-switcher id.
// The non-composition "New" targets. Each points at the surface that OWNS the
// create affordance, verified to exist rather than guessed: Conversations honours
// ?new=1 (a fresh thread on load), the Kanban board has a new-card sheet, and Muster
// owns both duty creation and Fitting stationing/cloning. Deep-linking straight
// into each create dialog would need a query contract per fitting; landing on the
// right surface is honest and never dead-ends.
const NEW_TARGETS: ReadonlyArray<{ label: string; href: string; hint: string }> = [
  // Deep-links Muster's Import/Export tab. Unlike the others this one is not
  // merely "the surface that owns creation" — importing a bundle IS how a
  // composition arrives from another machine, and burying it two clicks deep
  // would hide the only way in.
  {
    label: "Composition from a file",
    href: "/muster?section=transfer",
    hint: "import a .garrison.json bundle"
  },
  { label: "Conversation", href: "/talk?new=1", hint: "a new conversation" },
  { label: "Card", href: "/fitting/kanban-loop", hint: "a new Kanban card" },
  { label: "Duty", href: "/muster", hint: "add a duty to the composition" },
  { label: "Fitting", href: "/compose", hint: "station or clone a Fitting" }
];

function CompositionCreator({
  activeName,
  disabled,
  onCreate
}: {
  activeName: string | null;
  disabled: boolean;
  onCreate: (name: string) => Promise<boolean>;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Dismiss on outside-click / Escape. A menu that only closes by re-clicking its
  // own trigger traps the pointer on touch, where there is no hover to hint it.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: MouseEvent | TouchEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);
  const [newName, setNewName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLFormElement | null>(null);
  const submittingRef = useRef(false);

  useEffect(() => {
    submittingRef.current = submitting;
  }, [submitting]);

  useEffect(() => {
    if (!createOpen) return;
    const returnFocus = triggerRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submittingRef.current) {
        event.preventDefault();
        setCreateOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusables = root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
      window.requestAnimationFrame(() => returnFocus?.focus());
    };
  }, [createOpen]);

  return (
    <div className="composition-creator">
      {/* menuRef must wrap BOTH the trigger and the menu. It was declared but
          never attached, so `menuRef.current?.contains(...)` was always
          undefined and the outside-click handler below treated EVERY mousedown
          as outside — including one landing on a menu item. The menu unmounted
          between mousedown and mouseup, the click never completed on the item,
          and no entry in the New menu did anything. */}
      <div className="composition-creator-trigger-wrap" ref={menuRef}>
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          data-testid="new-menu"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title="Create something new"
          className="composition-creator-trigger"
        >
          <span aria-hidden="true">＋</span>
          New
        </button>
        {/* "New" used to create ONE thing (a composition). Everything else in
            Garrison is created from whichever surface owns it, which meant
            knowing where to go first. The menu keeps composition inline (it has
            a dialog right here) and routes the rest to the surface that owns the
            create affordance, so no entry is a dead end. */}
        {menuOpen ? (
          <div className="composition-creator-menu" role="menu" data-testid="new-menu-items">
            <button
              type="button"
              role="menuitem"
              disabled={disabled}
              data-testid="new-composition"
              title={
                disabled
                  ? "Clone an in-repo composition to create a new one"
                  : "Create from the active composition"
              }
              onClick={() => {
                setMenuOpen(false);
                setCreateOpen(true);
              }}
            >
              <b>Composition</b>
              <small>{disabled ? "clone an in-repo composition" : "from the active one"}</small>
            </button>
            {NEW_TARGETS.map((target) => (
              <a
                key={target.href}
                role="menuitem"
                href={target.href}
                onClick={() => setMenuOpen(false)}
              >
                <b>{target.label}</b>
                <small>{target.hint}</small>
              </a>
            ))}
          </div>
        ) : null}
      </div>
      {createOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="new-composition-title"
          data-testid="new-composition-dialog"
          className="composition-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !submitting) setCreateOpen(false);
          }}
        >
          <form
            ref={dialogRef}
            onSubmit={async (event) => {
              event.preventDefault();
              const name = newName.trim();
              if (!name || submitting) return;
              setSubmitting(true);
              const ok = await onCreate(name);
              setSubmitting(false);
              if (ok) {
                setNewName("");
                setCreateOpen(false);
              }
            }}
            className="composition-dialog"
          >
            <span className="composition-dialog-kicker">Clone composition</span>
            <h2 id="new-composition-title">
              New composition
            </h2>
            <p className="composition-dialog-copy">
              Start from a clean copy of {activeName ?? "the active composition"}.
              Runtime sessions and installed files are left behind.
            </p>
            <label htmlFor="new-composition-name">
              Name
            </label>
            <input
              id="new-composition-name"
              className="text"
              autoFocus
              value={newName}
              disabled={submitting}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="Codex build crew"
              data-testid="new-composition-name"
            />
            <div className="composition-dialog-actions">
              <button
                type="button"
                disabled={submitting}
                onClick={() => setCreateOpen(false)}
                className="btn ghost"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting || !newName.trim()}
                data-testid="new-composition-submit"
                className="btn primary"
              >
                {submitting ? "Creating and starting…" : "Create and start"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}

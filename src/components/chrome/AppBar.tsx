"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction
} from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, Menu } from "lucide-react";
import clsx from "clsx";

// The phone header. At phone width the shell has no rail: the app bar carries
// the menu button, the page's name, the node and session state, the shell's
// "New" control, and whatever controls the current page contributes. A page
// contributes through useAppBar(); the bar reads the latest contribution and
// falls back to a title derived from the route when nothing is registered.
export interface AppBarConfig {
  title?: string;
  // Replaces the menu button with a back control (the menu moves to the trailing
  // end). A string is the destination; `true` pops history when there is any.
  back?: boolean | string;
  // Trailing controls the page owns (a threads toggle, a filter). Pass a memoised
  // node: every change re-renders the bar.
  actions?: ReactNode;
}

const SetterCtx = createContext<Dispatch<SetStateAction<AppBarConfig | null>> | null>(null);
const ValueCtx = createContext<AppBarConfig | null>(null);

export function AppBarProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AppBarConfig | null>(null);
  return (
    <SetterCtx.Provider value={setConfig}>
      <ValueCtx.Provider value={config}>{children}</ValueCtx.Provider>
    </SetterCtx.Provider>
  );
}

// Register what the bar shows while the calling page is mounted. Outside the
// provider (tests rendering a page alone) it is a no-op.
export function useAppBar(config: AppBarConfig | null): void {
  const set = useContext(SetterCtx);
  const title = config?.title;
  const back = config?.back;
  const actions = config?.actions;
  useEffect(() => {
    if (!set) return;
    set(config ? { title, back, actions } : null);
    return () => set(null);
    // The config object is rebuilt on every render; its fields are the identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set, title, back, actions]);
}

export function useAppBarConfig(): AppBarConfig | null {
  return useContext(ValueCtx);
}

export function AppBar({
  fallbackTitle,
  subtitle,
  state,
  onMenu,
  trailing
}: {
  fallbackTitle: string;
  // Which node this window is on, under the title.
  subtitle: string | null;
  // Session state for the dot beside the subtitle.
  state: "running" | "idle" | "error" | null;
  onMenu: () => void;
  // The shell's own trailing control ("New"); rendered after the page's actions.
  trailing?: ReactNode;
}) {
  const router = useRouter();
  const config = useAppBarConfig();
  const title = config?.title ?? fallbackTitle;
  const back = config?.back;
  const menuButton = (
    <button type="button" className="app-bar-btn" aria-label="Open menu" onClick={onMenu}>
      <Menu size={20} aria-hidden />
    </button>
  );
  return (
    <header className="app-bar" data-testid="app-bar">
      {back ? (
        <button
          type="button"
          className="app-bar-btn"
          aria-label="Back"
          onClick={() => {
            if (typeof back === "string") router.push(back);
            else if (window.history.length > 1) router.back();
            else router.push("/");
          }}
        >
          <ChevronLeft size={22} aria-hidden />
        </button>
      ) : (
        menuButton
      )}
      <div className="app-bar-title">
        <span className="app-bar-name">{title}</span>
        {subtitle ? (
          <span className="app-bar-sub">
            {state ? (
              <span
                className={clsx("app-bar-state", `is-${state}`)}
                aria-label={`session ${state}`}
                role="img"
              />
            ) : null}
            {subtitle}
          </span>
        ) : null}
      </div>
      <div className="app-bar-actions">
        {config?.actions}
        {trailing}
        {back ? menuButton : null}
      </div>
    </header>
  );
}

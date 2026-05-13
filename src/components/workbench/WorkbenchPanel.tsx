"use client";

import { useState, useMemo, useEffect } from "react";
import clsx from "clsx";
import { Maximize2, Minimize2 } from "lucide-react";
import { useAppShell } from "@/components/chrome/AppShell";
import { faculties } from "@/lib/faculties";
import { lookupFittingView } from "@/components/fitting-views/registry";
import { onLaunchClaude } from "@/lib/workbench-bus";
import type { FacultyId } from "@/lib/types";

const WORKBENCH_FACULTY_IDS = new Set<FacultyId>(
  faculties.filter((f) => f.family === "workbench").map((f) => f.id)
);

export function WorkbenchPanel() {
  const { composition, library, sidebarCollapsed } = useAppShell();
  const sidebarW = sidebarCollapsed ? 48 : 244;
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [maximized, setMaximized] = useState(false);

  const tabs = useMemo(() => {
    const result: Array<{
      key: string;
      label: string;
      fittingId: string;
      viewId: string;
      config: Record<string, string | number | boolean>;
    }> = [];

    for (const entry of library) {
      if (!WORKBENCH_FACULTY_IDS.has(entry.faculty)) continue;
      const selections = composition?.selections[entry.faculty] ?? [];
      const sel = selections.find((s) => s.id === entry.id);
      if (!sel) continue;
      const facultyTabViews = (entry.metadata.ui?.views ?? []).filter(
        (v) => v.placement === "faculty-tab"
      );
      for (const view of facultyTabViews) {
        result.push({
          key: `${entry.id}:${view.id}`,
          label: entry.name,
          fittingId: entry.id,
          viewId: view.id,
          config: sel.config
        });
      }
    }
    return result;
  }, [composition, library]);

  // Switch to terminal tab when a worktree "Open Claude" button is clicked
  useEffect(() => {
    return onLaunchClaude(() => {
      const terminalTab = tabs.find((t) =>
        library.some((e) => e.faculty === "terminal" && e.id === t.fittingId)
      );
      if (terminalTab) setActiveKey(terminalTab.key);
    });
  }, [tabs, library]);

  useEffect(() => {
    if (!maximized) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMaximized(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [maximized]);

  if (tabs.length === 0) {
    return (
      <main>
        <div className="page wide">
          <div className="head">
            <h1>Workbench</h1>
          </div>
          <p style={{ color: "var(--mute)", fontSize: 13, marginTop: 8 }}>
            No Workbench tools installed. Add a <code>terminal</code>,{" "}
            <code>screen-share</code>, <code>worktree-management</code>, or{" "}
            <code>session-view</code> Fitting to your composition and start the Operative.
          </p>
        </div>
      </main>
    );
  }

  const fallbackTab = tabs[0];
  if (!fallbackTab) {
    // Belt-and-suspenders — the guard above already covers tabs.length === 0,
    // but if the array somehow becomes empty after render TypeScript still
    // needs to know we won't dereference undefined.
    return null;
  }
  const currentKey = activeKey ?? fallbackTab.key;
  const activeTab = tabs.find((t) => t.key === currentKey) ?? fallbackTab;
  const ActiveComponent = lookupFittingView(activeTab.fittingId, activeTab.viewId);

  return (
    <main style={maximized ? {
      position: "fixed",
      left: sidebarW,
      top: 0,
      right: 0,
      bottom: 0,
      zIndex: 100,
      background: "var(--paper, white)",
      display: "flex",
      flexDirection: "column",
    } : {
      display: "flex",
      flexDirection: "column",
      height: "100%",
    }}>
      <div
        className="strip"
        style={{ padding: "0 20px", borderBottom: "1px solid var(--rule)", flexShrink: 0, marginBottom: 0 }}
        role="tablist"
        aria-label="Workbench Fittings"
      >
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={tab.key === currentKey}
            title={`Open ${tab.label}`}
            className={clsx("btn", "small", tab.key === currentKey ? "primary" : "ghost")}
            onClick={() => setActiveKey(tab.key)}
            style={{ marginRight: 4 }}
          >
            {tab.label}
          </button>
        ))}
        <span style={{ marginLeft: "auto" }} />
        <button
          type="button"
          className="btn ghost small"
          onClick={() => setMaximized((m) => !m)}
          title={maximized ? "Exit fullscreen (Esc)" : "Maximize"}
          style={{ marginLeft: 4 }}
        >
          <span className="ic">
            {maximized ? <Minimize2 size={13} aria-hidden /> : <Maximize2 size={13} aria-hidden />}
          </span>
        </button>
      </div>
      <div style={{ flex: 1, overflow: "hidden" }}>
        {ActiveComponent ? (
          <ActiveComponent config={activeTab.config} params={{}} />
        ) : (
          <div style={{ padding: 20, color: "var(--mute)", fontSize: 13 }}>
            View <code>{currentKey}</code> is not registered in the fitting-views registry.
          </div>
        )}
      </div>
    </main>
  );
}

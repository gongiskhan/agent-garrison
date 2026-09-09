import React, { useEffect, useId, useRef, type ReactNode } from "react";
import { CloseIcon } from "./icons";

export function Sheet({ title, onClose, children, size = "default", tabs, className }: {
  title: ReactNode; onClose: () => void; children: ReactNode;
  size?: "default" | "mid" | "wide" | "conv"; tabs?: ReactNode; className?: string;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
      if (event.key !== "Tab") return;
      const items = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? [])].filter((item) => item.getClientRects().length);
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); previous?.focus(); };
  }, []);
  return <div className="sheet-backdrop" onClick={onClose}>
    <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId}
      className={`sheet${size === "wide" ? " wide" : size === "mid" ? " mid" : size === "conv" ? " wide conv" : ""}${className ? ` ${className}` : ""}`}
      onClick={(event) => event.stopPropagation()}>
      <div className="sh-head"><h3 id={titleId}>{title}</h3><button className="btn small sh-close" onClick={onClose} aria-label="Close"><CloseIcon /></button></div>
      {tabs}<div className="sh-body">{children}</div>
    </div>
  </div>;
}

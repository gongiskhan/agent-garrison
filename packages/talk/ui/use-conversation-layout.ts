import { useEffect, useId, useRef, useState } from "react";

/** The shell can consume a quarter of the viewport. Size the drawer against
 * the conversation pane itself, and keep its hidden controls out of Tab order. */
export function useConversationLayout(open: boolean, close: () => void) {
  const shellRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const sidebarId = useId();
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const resize = () => setCompact(shell.getBoundingClientRect().width <= 900);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const sidebar = sidebarRef.current;
    const main = mainRef.current;
    if (!sidebar || !main) return;
    sidebar.toggleAttribute("inert", compact && !open);
    main.toggleAttribute("inert", compact && open);
    if (!compact || !open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => [...sidebar.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]',
    )].filter((el) => el.getClientRects().length > 0);
    const field = sidebar.querySelector<HTMLInputElement>('input[type="search"]');
    (field ?? focusable()[0])?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") { event.preventDefault(); close(); }
      if (event.key !== "Tab") return;
      const elements = focusable();
      const first = elements[0], last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    sidebar.addEventListener("keydown", keydown);
    return () => {
      sidebar.removeEventListener("keydown", keydown);
      main.removeAttribute("inert");
      if (previous?.isConnected) previous.focus();
    };
  }, [compact, open, close]);

  return { shellRef, sidebarRef, mainRef, sidebarId, compact };
}

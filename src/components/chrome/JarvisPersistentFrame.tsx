"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useFittingViewStatus } from "@/components/fitting-views/useFittingViewStatus";
import { resolveViewUrl } from "@/components/fitting-views/browser-view-url";
import type { Composition, LibraryEntry } from "@/lib/types";

// jarvis-os (Phase 1 of the persistent-HUD fix): the own-port Jarvis HUD used
// to live inside /embed/jarvis-os's own <iframe>, which Next.js client-side
// navigation UNMOUNTS on every tab switch — destroying the whole browsing
// context: conversation history, getUserMedia + the Silero VAD wasm module,
// both EventSource connections, the in-flight turn's AbortController, and TTS
// playback. This component mounts ONE iframe, here in AppShell (which never
// unmounts across route changes), and merely repositions it. /embed/jarvis-os
// (src/app/embed/[fittingId]/page.tsx) special-cases this fitting id to
// render nothing of its own — this is the only place a jarvis-os iframe is
// ever created, so two can never exist at once.
//
// Special-cased to this one Fitting id deliberately, not generalised to every
// own-port view — that is future work; Phase 1's scope is exactly Jarvis.
//
// Phase 3 (orb mode) extends the SAME iframe (never a second one, never a
// remount) with a third framing in addition to hidden/visible: shrunk to a
// small draggable circle that floats over every other Garrison page. See the
// orb-mode block below for the shell<->HUD postMessage handshake and why the
// clip-path + CSS transition live directly on this <iframe> element per the
// brief, while the mute/expand controls next to it are separate sibling
// elements rather than something squeezed inside the iframe's own clip.
export const JARVIS_FITTING_ID = "jarvis-os";
export const JARVIS_EMBED_PATH = `/embed/${JARVIS_FITTING_ID}`;

// Hidden state: NOT display:none and NOT visibility:hidden. Both remove the
// iframe from the render/paint tree, which is documented (and was reproduced
// here via devtools' Media panel + the mic indicator: a display:none iframe's
// getUserMedia tracks show "muted" and its audio element stops advancing
// currentTime) to suspend media decode / capture once a frame stops being
// painted. Parking it off the visible viewport - full size, still painted,
// still `visibility: visible` - is the same technique embedded call/chat
// widgets (Intercom, Meet's PiP tile, Jitsi's iframe API) use to keep
// getUserMedia + WebAudio + EventSource alive while their UI isn't on screen.
//
// Fixed px top/left (not the old `left: -10000px` shorthand) so this state
// shares a transitionable coordinate space with ORB_STYLE below — animating
// FROM off-screen INTO the visible corner orb only works if both states move
// the same `top`/`left` properties, not `left` on one and `right` on the
// other.
const HIDDEN_TOP = 0;
const HIDDEN_LEFT = -10000;
const HIDDEN_STYLE: CSSProperties = {
  position: "fixed",
  top: HIDDEN_TOP,
  left: HIDDEN_LEFT,
  width: "1280px",
  height: "800px",
  border: 0,
  visibility: "visible",
  opacity: 1,
  pointerEvents: "none",
  clipPath: "none",
  transition: "top 0.32s cubic-bezier(0.22, 1, 0.36, 1), left 0.32s cubic-bezier(0.22, 1, 0.36, 1), width 0.32s cubic-bezier(0.22, 1, 0.36, 1), height 0.32s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.2s ease"
};

// Visible state: absolutely fills the (position: relative) .shell-content
// column that /embed/jarvis-os would otherwise render its own full-bleed
// iframe into - see the removed per-route iframe in embed/[fittingId]/page.tsx.
// position:absolute (not :fixed) means this state doesn't share a coordinate
// space with HIDDEN/ORB - the jump when entering/leaving the dedicated route
// is a natural cut (a route navigation already repaints the whole page), not
// something Phase 3's transition requirement is about.
const VISIBLE_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  border: 0,
  display: "block",
  background: "var(--paper)",
  clipPath: "none"
};

// ── Orb mode geometry (Phase 3) ──────────────────────────────────────────
// Mirrors fittings/seed/jarvis-os/ui/orb-settings.ts (Fittings are standalone
// packages - see that file's own header - so this is a deliberate copy, not a
// cross-package import; keep the two in sync by hand if either changes).
// ORB_BOX is the iframe's own on-screen box while orb-active: bigger than the
// visible ORB_CIRCLE so clip-path leaves a real ring around the circle for
// dragging (see .jarvis-orb-draghandle below - it sits at the exact same
// rect, one layer behind the iframe, and only receives pointer events in that
// clipped-away ring, never on the visible orb itself).
const ORB_BOX = 160;
const ORB_CIRCLE = 88;
const ORB_MARGIN = 20;
const ORB_BTN = 30;
const ORB_OPACITY = 0.96;

type OrbCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
const DEFAULT_ORB_CORNER: OrbCorner = "bottom-right";
function isOrbCorner(v: unknown): v is OrbCorner {
  return v === "top-left" || v === "top-right" || v === "bottom-left" || v === "bottom-right";
}

function cornerBox(corner: OrbCorner, vw: number, vh: number) {
  const left = corner.endsWith("right") ? vw - ORB_BOX - ORB_MARGIN : ORB_MARGIN;
  const top = corner.startsWith("bottom") ? vh - ORB_BOX - ORB_MARGIN : ORB_MARGIN;
  return { top, left };
}

export function JarvisPersistentFrame({
  composition,
  library,
  onActivityChange
}: {
  composition: Composition | null;
  library: LibraryEntry[];
  onActivityChange?: (active: boolean) => void;
}) {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const onJarvisRoute = pathname === JARVIS_EMBED_PATH;
  const { entries: viewStatuses } = useFittingViewStatus();

  // Stationed: jarvis-os is selected into some Faculty of the active
  // composition. Mirrors Sidebar's FittingViewsLinks selectedIds logic.
  const stationed = useMemo(() => {
    if (!composition) return false;
    for (const selections of Object.values(composition.selections)) {
      if ((selections ?? []).some((selection) => selection.id === JARVIS_FITTING_ID)) {
        return true;
      }
    }
    return false;
  }, [composition]);
  const knownFitting = library.some((entry) => entry.id === JARVIS_FITTING_ID);

  const view = viewStatuses.find((entry) => entry.fittingId === JARVIS_FITTING_ID) ?? null;
  const resolvedSrc = view?.healthy ? resolveViewUrl(view) : "";

  // Sticky src: once we have a reachable URL, keep it - a later transient
  // health-poll miss (the poll is a 15s interval, server-side) must never
  // tear the iframe down mid-turn just because one poll raced a restart.
  // Cleared only when the Fitting is no longer stationed/known at all.
  const [mountedSrc, setMountedSrc] = useState<string | null>(null);
  useEffect(() => {
    if (resolvedSrc && !mountedSrc) setMountedSrc(resolvedSrc);
  }, [resolvedSrc, mountedSrc]);
  useEffect(() => {
    if (!stationed || !knownFitting) setMountedSrc(null);
  }, [stationed, knownFitting]);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const iframeOrigin = useMemo(() => {
    if (!mountedSrc) return "*";
    try {
      return new URL(mountedSrc, window.location.href).origin;
    } catch {
      return "*";
    }
  }, [mountedSrc]);
  const postToJarvis = useCallback((msg: Record<string, unknown>) => {
    try {
      iframeRef.current?.contentWindow?.postMessage(msg, iframeOrigin);
    } catch {}
  }, [iframeOrigin]);
  // Stable refs so the zero-dep message handler always uses the latest values
  // without being re-registered on every orbActive/postToJarvis change.
  const orbActiveRef = useRef(false);
  const postToJarvisRef = useRef(postToJarvis);
  postToJarvisRef.current = postToJarvis;

  // Activity signal: jarvis-os posts {type:"garrison:jarvis-activity",
  // active} to its parent whenever its HUD mode changes (see the minimal emit
  // added to setMode in fittings/seed/jarvis-os/ui/main.tsx). Surfaced up to
  // AppShell so the sidebar can light up the Jarvis entry while the user is
  // elsewhere - reuses the postMessage channel already established for
  // cross-Fitting navigation (garrison:navigate-fitting) rather than a new one.
  //
  // Phase 3 adds two more inbound message types on the SAME channel:
  //   garrison:jarvis-orb-pref  {active, corner} - the HUD's persisted "shrink
  //     to a corner orb elsewhere" preference (see SettingsPanel.tsx there).
  //     This is a PREFERENCE, not "am I currently the orb" - see the reply
  //     message below for why those are kept separate.
  //   garrison:jarvis-mic-state {micMuted, sessionOn} - lets the shell-side
  //     mute button (rendered next to the orb, not inside the iframe) show
  //     the right icon and only appear when a session actually exists.
  const onActivityChangeRef = useRef(onActivityChange);
  onActivityChangeRef.current = onActivityChange;
  const [orbPref, setOrbPref] = useState(false);
  const [orbCorner, setOrbCorner] = useState<OrbCorner>(DEFAULT_ORB_CORNER);
  const [micState, setMicState] = useState({ micMuted: false, sessionOn: false });
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "garrison:jarvis-activity") {
        onActivityChangeRef.current?.(Boolean(data.active));
      } else if (data.type === "garrison:jarvis-orb-pref") {
        setOrbPref(Boolean(data.active));
        if (isOrbCorner(data.corner)) setOrbCorner(data.corner);
      } else if (data.type === "garrison:jarvis-mic-state") {
        setMicState({ micMuted: Boolean(data.micMuted), sessionOn: Boolean(data.sessionOn) });
      } else if (data.type === "garrison:jarvis-ready") {
        // HUD just mounted and its listener is live — respond immediately with
        // the current framing so it never stays stuck at isOrbDisplay=false if
        // the previous display-mode message fired before the listener existed.
        postToJarvisRef.current({
          type: "garrison:jarvis-display-mode",
          mode: orbActiveRef.current ? "orb" : "normal"
        });
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // What this HUD should actually render as right now. onJarvisRoute always
  // wins over the orb preference - navigating to the dedicated Jarvis tab
  // (e.g. via the sidebar entry, which is how "jump back to the full Jarvis
  // tab" is satisfied from orb mode - see the expand button below) means the
  // user wants the full HUD even if "shrink elsewhere" is still turned on.
  // Guarded on mountedSrc (own-port view actually up and healthy) so orb mode
  // never overlays a dead iframe - flipping the preference on before jarvis-os
  // has finished booting just renders nothing until it's reachable.
  const orbActive = Boolean(mountedSrc) && !onJarvisRoute && orbPref;
  orbActiveRef.current = orbActive;

  // Tell the HUD which framing actually applied - only THIS (not the raw
  // preference) drives its transparent-background / hide-chrome CSS, because
  // the preference stays "on" even while this same tab shows full-size on its
  // own route (see fittings/seed/jarvis-os/ui/main.tsx's isOrbDisplay).
  useEffect(() => {
    postToJarvis({ type: "garrison:jarvis-display-mode", mode: orbActive ? "orb" : "normal" });
  }, [orbActive, postToJarvis]);

  // ── Orb drag + corner-snap ────────────────────────────────────────────────
  const [viewport, setViewport] = useState(() => ({
    w: typeof window === "undefined" ? 1024 : window.innerWidth,
    h: typeof window === "undefined" ? 768 : window.innerHeight
  }));
  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const restBox = cornerBox(orbCorner, viewport.w, viewport.h);
  const [dragBox, setDragBox] = useState<{ top: number; left: number } | null>(null);
  const draggingRef = useRef<{ pointerId: number; dx: number; dy: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const onDragHandlePointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return; // never start a drag from a button/iframe click bubbling up
    const box = dragBox ?? restBox;
    draggingRef.current = { pointerId: e.pointerId, dx: e.clientX - box.left, dy: e.clientY - box.top };
    setIsDragging(true);
    setDragBox(box);
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
  }, [dragBox, restBox]);

  useEffect(() => {
    if (!isDragging) return;
    function onMove(e: PointerEvent) {
      const d = draggingRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      setDragBox({ left: e.clientX - d.dx, top: e.clientY - d.dy });
    }
    function onUp(e: PointerEvent) {
      const d = draggingRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      draggingRef.current = null;
      setIsDragging(false);
      // Snap to whichever screen quadrant the orb's CENTER ended up in.
      setDragBox((box) => {
        const b = box ?? restBox;
        const cx = b.left + ORB_BOX / 2;
        const cy = b.top + ORB_BOX / 2;
        const next: OrbCorner = `${cy < viewport.h / 2 ? "top" : "bottom"}-${cx < viewport.w / 2 ? "left" : "right"}` as OrbCorner;
        setOrbCorner(next);
        postToJarvis({ type: "garrison:jarvis-set-orb-corner", corner: next });
        return null; // fall back to the corner-computed rest position, now equal to `next`
      });
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [isDragging, restBox, viewport, postToJarvis]);

  const box = dragBox ?? restBox;
  const orbTransition = isDragging
    ? "none"
    : "top 0.32s cubic-bezier(0.22, 1, 0.36, 1), left 0.32s cubic-bezier(0.22, 1, 0.36, 1), width 0.32s cubic-bezier(0.22, 1, 0.36, 1), height 0.32s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.2s ease";

  const ORB_STYLE: CSSProperties = {
    position: "fixed",
    top: box.top,
    left: box.left,
    width: ORB_BOX,
    height: ORB_BOX,
    border: 0,
    display: "block",
    background: "transparent",
    opacity: ORB_OPACITY,
    // A plain circle, not a union with the mute/expand buttons' area - those
    // are separate sibling elements OUTSIDE this box entirely (see below),
    // not squeezed inside the iframe's own clip, so their hit area was never
    // the clip-path's problem to solve.
    clipPath: `circle(${ORB_CIRCLE / 2}px at 50% 50%)`,
    transition: orbTransition,
    zIndex: 9000,
    boxShadow: isDragging ? "0 12px 34px rgba(0,0,0,0.5)" : "none"
  };

  const frameStyle: CSSProperties = onJarvisRoute ? VISIBLE_STYLE : orbActive ? ORB_STYLE : { ...HIDDEN_STYLE, transition: isDragging ? "none" : HIDDEN_STYLE.transition };

  // Expand: jump back to the dedicated Jarvis tab (constraint 10). Reuses
  // ordinary client-side navigation - the SAME iframe just gets VISIBLE_STYLE
  // once onJarvisRoute flips true, no remount. orbPref itself is left alone
  // (it's a standing preference the HUD keeps in Settings, not something
  // "expand" should silently switch off).
  const goFull = useCallback(() => router.push(JARVIS_EMBED_PATH), [router]);
  const toggleMute = useCallback(() => postToJarvis({ type: "garrison:jarvis-mute-toggle" }), [postToJarvis]);

  // Buttons sit just outside the orb's own box, offset toward whichever side
  // faces screen center - flips left/right with the docked corner so they're
  // never pushed off-screen; the vertical spots (near the box's own top/
  // bottom edge) are already inside the box's own on-screen extent, so no
  // separate top/bottom flip is needed.
  const btnInner = orbCorner.endsWith("right") ? box.left - ORB_BTN - 12 : box.left + ORB_BOX + 12;
  const expandStyle: CSSProperties = {
    position: "fixed",
    top: box.top + 14,
    left: btnInner,
    width: ORB_BTN,
    height: ORB_BTN,
    zIndex: 9001,
    transition: orbTransition
  };
  const muteStyle: CSSProperties = {
    position: "fixed",
    top: box.top + ORB_BOX - 14 - ORB_BTN,
    left: btnInner,
    width: ORB_BTN,
    height: ORB_BTN,
    zIndex: 9001,
    transition: orbTransition
  };

  if (!stationed || !knownFitting || !mountedSrc) return null;

  return (
    <>
      {orbActive && (
        <div
          className="jarvis-orb-draghandle"
          onPointerDown={onDragHandlePointerDown}
          style={{
            position: "fixed",
            top: box.top,
            left: box.left,
            width: ORB_BOX,
            height: ORB_BOX,
            borderRadius: "50%",
            zIndex: 8990,
            cursor: isDragging ? "grabbing" : "grab",
            touchAction: "none",
            transition: orbTransition
          }}
          title="Arrasta para reposicionar"
        />
      )}
      <iframe
        ref={iframeRef}
        title={JARVIS_FITTING_ID}
        src={mountedSrc}
        // Own-port views run on a different port (a distinct origin) - mirrors
        // the allow list from the removed per-route jarvis-os iframe.
        allow="clipboard-read; clipboard-write; microphone; autoplay"
        aria-hidden={onJarvisRoute ? undefined : true}
        tabIndex={onJarvisRoute ? undefined : -1}
        style={frameStyle}
        onLoad={() => {
          // Belt-and-suspenders: re-send on every iframe load. The ready-
          // handshake (garrison:jarvis-ready above) handles the normal case;
          // this covers a reload/navigation inside the iframe itself.
          postToJarvis({ type: "garrison:jarvis-display-mode", mode: orbActive ? "orb" : "normal" });
        }}
      />
      {orbActive && (
        <button
          type="button"
          className="jarvis-orb-expand-btn"
          style={expandStyle}
          onClick={goFull}
          title="Abrir o Jarvis completo"
          aria-label="Abrir o Jarvis completo"
        >
          ⤢
        </button>
      )}
      {orbActive && micState.sessionOn && (
        <button
          type="button"
          className="jarvis-orb-mute-btn"
          style={muteStyle}
          onClick={toggleMute}
          title={micState.micMuted ? "Retirar mute" : "Mute"}
          aria-label={micState.micMuted ? "Unmute microphone" : "Mute microphone"}
        >
          {micState.micMuted ? "🔇" : "🎙"}
        </button>
      )}
    </>
  );
}

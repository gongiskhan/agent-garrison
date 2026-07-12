"use client";

// TourEngine — the single in-app tour engine (WS6). Mounted once in the app
// shell, it watches the URL for ?tour=<name>&mode=demo|guided, loads the
// descriptor from /api/tours/<name>, navigates to the tour's route if needed,
// and drives an overlay: a dimmed backdrop with a spotlight cutout on the
// current step's target, a caption card, a step counter, and controls. Two
// players share this engine: DEMO (auto-advances and performs each step's
// action) and GUIDED (spotlights the target and waits for the user, validating
// via the step's assert). Escape or Exit tears the tour down and strips the URL
// params. See src/lib/tour-selector.ts (resolver/assert/action) and
// src/lib/tour-machine.ts (advance logic).
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  resolveSelector,
  performAction,
  type TourDescriptor,
  type TourStep
} from "@/lib/tour-selector";
import {
  initTour,
  advanceTour,
  isComplete,
  stepIsAssertGated,
  shouldGuidedAdvance,
  type TourState
} from "@/lib/tour-machine";

type Mode = "demo" | "guided";

const SPOTLIGHT_PAD = 8;
const DEMO_HOLD_MS = 3200;
const DEMO_ACTION_DELAY_MS = 900;
const POLL_MS = 250;
const RESOLVE_TIMEOUT_MS = 8000;

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

// Read ?tour / &mode off the current URL (client only).
function readParams(): { name: string | null; mode: string | null } {
  if (typeof window === "undefined") return { name: null, mode: null };
  const sp = new URLSearchParams(window.location.search);
  return { name: sp.get("tour"), mode: sp.get("mode") };
}

export function TourEngine() {
  const router = useRouter();
  const pathname = usePathname();

  const [name, setName] = useState<string | null>(null);
  const [urlMode, setUrlMode] = useState<string | null>(null);
  const [descriptor, setDescriptor] = useState<TourDescriptor | null>(null);
  const [tourState, setTourState] = useState<TourState | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "playing" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);

  // Re-read the URL params on mount, on history navigation, and on any client
  // route change (usePathname re-renders us). This is how a launched tour
  // (?tour=… added by the Assistant) is picked up.
  useEffect(() => {
    const sync = () => {
      const p = readParams();
      setName(p.name);
      setUrlMode(p.mode);
    };
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [pathname]);

  // Load the descriptor whenever the active tour name changes.
  useEffect(() => {
    if (!name) {
      setDescriptor(null);
      setTourState(null);
      setStatus("idle");
      setError(null);
      return;
    }
    let cancelled = false;
    setStatus("loading");
    setError(null);
    void fetch(`/api/tours/${encodeURIComponent(name)}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setStatus("error");
          setError(typeof data?.error === "string" ? data.error : `tour "${name}" not found`);
          setDescriptor(null);
          return;
        }
        const tour = data.tour as TourDescriptor;
        setDescriptor(tour);
        setTourState(initTour(tour.steps.length));
        setStatus("playing");
      })
      .catch((err) => {
        if (cancelled) return;
        setStatus("error");
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [name]);

  // Navigate to the tour's route if we launched it from elsewhere. Keeps the
  // ?tour params so a reload mid-tour resumes; the engine survives the client
  // navigation (it lives in the persistent shell).
  useEffect(() => {
    if (!descriptor) return;
    if (pathname === descriptor.route) return;
    const params = new URLSearchParams();
    params.set("tour", descriptor.name);
    if (urlMode) params.set("mode", urlMode);
    router.push(`${descriptor.route}?${params.toString()}`);
  }, [descriptor, pathname, urlMode, router]);

  const mode: Mode = (urlMode === "demo" || urlMode === "guided"
    ? urlMode
    : descriptor?.mode ?? "guided") as Mode;

  const step: TourStep | undefined =
    descriptor && tourState ? descriptor.steps[tourState.index] : undefined;

  // Resolve + measure the current step's target. Polls until it appears (routes
  // load async), then tracks it on scroll/resize.
  useEffect(() => {
    if (!step || status !== "playing") {
      setRect(null);
      return;
    }
    let raf = 0;
    let timer = 0;
    const started = Date.now();
    const measure = () => {
      const el = resolveSelector(step.selector);
      if (el && typeof (el as HTMLElement).getBoundingClientRect === "function") {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width > 0 || r.height > 0) {
          setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
          return true;
        }
      }
      setRect(null);
      return false;
    };
    const tick = () => {
      const found = measure();
      if (!found && Date.now() - started < RESOLVE_TIMEOUT_MS) {
        timer = window.setTimeout(() => {
          raf = window.requestAnimationFrame(tick);
        }, POLL_MS);
      }
    };
    tick();
    const track = () => measure();
    window.addEventListener("scroll", track, true);
    window.addEventListener("resize", track);
    return () => {
      window.clearTimeout(timer);
      window.cancelAnimationFrame(raf);
      window.removeEventListener("scroll", track, true);
      window.removeEventListener("resize", track);
    };
  }, [step, status, pathname]);

  const endTour = useCallback(() => {
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.delete("tour");
      url.searchParams.delete("mode");
      window.history.replaceState({}, "", url.toString());
    }
    setName(null);
    setUrlMode(null);
    setDescriptor(null);
    setTourState(null);
    setRect(null);
    setStatus("idle");
    setError(null);
  }, []);

  const advance = useCallback(() => {
    setTourState((prev) => {
      if (!prev) return prev;
      const next = advanceTour(prev);
      return next;
    });
  }, []);

  // Auto-close shortly after the final step completes.
  useEffect(() => {
    if (tourState && isComplete(tourState) && descriptor) {
      const t = window.setTimeout(endTour, DEMO_HOLD_MS);
      return () => window.clearTimeout(t);
    }
  }, [tourState, descriptor, endTour]);

  // --- DEMO player: auto-advance, performing each step's action -------------
  useEffect(() => {
    if (mode !== "demo" || !step || !tourState || status !== "playing") return;
    if (isComplete(tourState)) return;
    let actionTimer = 0;
    let holdTimer = 0;
    if (step.action) {
      actionTimer = window.setTimeout(() => {
        const el = resolveSelector(step.selector);
        if (el) {
          setActing(true);
          if (step.action!.type === "navigate" && step.action!.path) {
            router.push(step.action!.path);
          } else {
            performAction(el, step.action!);
          }
          window.setTimeout(() => setActing(false), 500);
        }
      }, DEMO_ACTION_DELAY_MS);
    }
    holdTimer = window.setTimeout(advance, DEMO_HOLD_MS);
    return () => {
      window.clearTimeout(actionTimer);
      window.clearTimeout(holdTimer);
    };
  }, [mode, step, tourState, status, advance, router]);

  // --- GUIDED player: wait for the user, validate via the step's assert -----
  useEffect(() => {
    if (mode !== "guided" || !step || !tourState || status !== "playing") return;
    if (isComplete(tourState)) return;
    if (!stepIsAssertGated(step)) return; // informational step → user presses Continue
    const poll = window.setInterval(() => {
      if (shouldGuidedAdvance(step, { pathname: window.location.pathname })) {
        advance();
      }
    }, POLL_MS);
    return () => window.clearInterval(poll);
  }, [mode, step, tourState, status, advance]);

  // Escape exits any tour.
  useEffect(() => {
    if (!descriptor) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        endTour();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [descriptor, endTour]);

  if (status === "error" && error) {
    return <TourToast message={error} onClose={endTour} />;
  }
  if (!descriptor || !tourState || status !== "playing" || !step) return null;

  const assertGated = mode === "guided" && stepIsAssertGated(step);

  return (
    <TourOverlay
      title={descriptor.title}
      step={step}
      index={tourState.index}
      total={descriptor.steps.length}
      mode={mode}
      rect={rect}
      acting={acting}
      complete={isComplete(tourState)}
      assertGated={assertGated}
      onNext={advance}
      onExit={endTour}
    />
  );
}

// --- overlay ----------------------------------------------------------------

function TourOverlay({
  title,
  step,
  index,
  total,
  mode,
  rect,
  acting,
  complete,
  assertGated,
  onNext,
  onExit
}: {
  title: string;
  step: TourStep;
  index: number;
  total: number;
  mode: Mode;
  rect: Rect | null;
  acting: boolean;
  complete: boolean;
  assertGated: boolean;
  onNext: () => void;
  onExit: () => void;
}) {
  const spotlight = rect
    ? {
        top: rect.top - SPOTLIGHT_PAD,
        left: rect.left - SPOTLIGHT_PAD,
        width: rect.width + SPOTLIGHT_PAD * 2,
        height: rect.height + SPOTLIGHT_PAD * 2
      }
    : null;

  const caption = captionPosition(spotlight);
  const ringColor = acting ? "#f0a020" : "#2f9e6f";

  return (
    <div
      aria-live="polite"
      role="dialog"
      aria-label={`Tour: ${title}`}
      style={{ position: "fixed", inset: 0, zIndex: 3000, pointerEvents: "none" }}
    >
      {/* Spotlight cutout: a box-shadow ring dims everything but the target.
          pointer-events: none so the real target stays clickable (guided). */}
      {spotlight ? (
        <div
          data-testid="tour-spotlight"
          style={{
            position: "fixed",
            top: spotlight.top,
            left: spotlight.left,
            width: spotlight.width,
            height: spotlight.height,
            borderRadius: 8,
            boxShadow: `0 0 0 9999px rgba(14, 22, 18, 0.58)`,
            border: `2px solid ${ringColor}`,
            outline: acting ? `3px solid ${ringColor}` : "none",
            transition: "top 180ms ease, left 180ms ease, width 180ms ease, height 180ms ease, border-color 120ms ease",
            pointerEvents: "none"
          }}
        />
      ) : (
        // No target yet — dim the whole screen so the caption reads clearly.
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(14, 22, 18, 0.58)",
            pointerEvents: "none"
          }}
        />
      )}

      {/* Caption card */}
      <div
        data-testid="tour-caption"
        style={{
          position: "fixed",
          top: caption.top,
          left: caption.left,
          width: 340,
          maxWidth: "calc(100vw - 32px)",
          background: "var(--paper, #ffffff)",
          color: "var(--ink, #18211c)",
          border: "1px solid var(--rule, #d8ded9)",
          borderRadius: 10,
          boxShadow: "0 8px 28px rgba(14, 22, 18, 0.28)",
          padding: "14px 16px 12px",
          pointerEvents: "auto",
          fontFamily: "var(--font-sans, system-ui, sans-serif)"
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            marginBottom: 8
          }}
        >
          <span
            style={{
              fontSize: 10.5,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: "var(--mute, #67736c)",
              fontWeight: 600
            }}
          >
            {mode === "demo" ? "Demo tour" : "Guided tour"} · {title}
          </span>
          <span data-testid="tour-counter" style={{ fontSize: 11, color: "var(--mute, #67736c)", whiteSpace: "nowrap" }}>
            {index + 1} / {total}
          </span>
        </div>

        <p style={{ margin: "0 0 12px", fontSize: 14, lineHeight: 1.5 }}>{step.caption}</p>

        {mode === "guided" && assertGated && !complete ? (
          <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--mute, #67736c)" }}>
            Do the highlighted action to continue.
          </p>
        ) : null}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            type="button"
            data-testid="tour-exit"
            onClick={onExit}
            style={btnStyle(false)}
          >
            Exit
          </button>
          {complete ? (
            <button type="button" data-testid="tour-done" onClick={onExit} style={btnStyle(true)}>
              Done
            </button>
          ) : mode === "guided" ? (
            <button type="button" data-testid="tour-next" onClick={onNext} style={btnStyle(true)}>
              {assertGated ? "Skip" : "Continue"}
            </button>
          ) : (
            <button type="button" data-testid="tour-next" onClick={onNext} style={btnStyle(true)}>
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function TourToast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const t = window.setTimeout(onClose, 4000);
    return () => window.clearTimeout(t);
  }, [onClose]);
  return (
    <div
      role="alert"
      style={{
        position: "fixed",
        bottom: 18,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 3000,
        background: "var(--paper, #fff)",
        color: "var(--ink, #18211c)",
        border: "1px solid var(--rule, #d8ded9)",
        borderRadius: 8,
        padding: "8px 14px",
        fontSize: 13,
        boxShadow: "0 6px 20px rgba(14,22,18,0.24)"
      }}
    >
      {message}
    </div>
  );
}

function btnStyle(primary: boolean): React.CSSProperties {
  return primary
    ? {
        border: "1px solid #1f6f4c",
        background: "#227a53",
        color: "#fff",
        borderRadius: 6,
        padding: "6px 14px",
        fontSize: 12.5,
        cursor: "pointer"
      }
    : {
        border: "1px solid var(--rule, #d8ded9)",
        background: "transparent",
        color: "var(--mute, #67736c)",
        borderRadius: 6,
        padding: "6px 12px",
        fontSize: 12.5,
        cursor: "pointer"
      };
}

// Place the caption below the spotlight when there's room, else above, else
// pinned bottom-center when there's no target rect yet.
function captionPosition(spotlight: Rect | null): { top: number; left: number } {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  if (!spotlight) {
    return { top: Math.round(vh / 2 - 60), left: Math.round(vw / 2 - 170) };
  }
  const cardW = 340;
  const cardH = 150;
  let left = spotlight.left + spotlight.width / 2 - cardW / 2;
  left = Math.max(16, Math.min(left, vw - cardW - 16));
  let top = spotlight.top + spotlight.height + 14;
  if (top + cardH > vh - 12) {
    top = Math.max(16, spotlight.top - cardH - 14);
  }
  return { top: Math.round(top), left: Math.round(left) };
}

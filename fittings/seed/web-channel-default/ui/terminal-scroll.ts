// Scrolling for a terminal whose history lives on the far side of the wire.
//
// A `tmux attach` client sits in the alternate screen forever, so the local
// xterm.js has no scrollback of its own to move. Its two built-in reactions are
// both wrong here:
//
//   - wheel  → with no scrollback xterm.js emits cursor-key sequences instead
//              (its convenience for `less`/`vim`). An agent TUI reads those as
//              "recall the previous message", so the wheel edits the prompt
//              instead of scrolling the output.
//   - touch  → panning drives the local viewport, which has nothing in it; and
//              once the remote turns mouse tracking on, xterm.js skips its
//              touch handlers entirely. Either way the finger does nothing.
//
// The pane's history is tmux's, and copy-mode is the only way into it — which
// is exactly what tmux mouse mode binds the wheel to. The fitting sets `mouse
// on` per session at attach, so the DESKTOP wheel then needs no help: xterm.js
// reports it and tmux scrolls. This module covers the rest:
//
//   1. Touch: vertical pan is replayed as real WheelEvents on the terminal, so
//      xterm.js encodes them in whatever mouse protocol the remote negotiated —
//      no hand-rolled escape sequences to drift.
//   2. The mouse-off fallback: on a tmux pane whose mouse mode never took, the
//      wheel is swallowed rather than allowed to become cursor keys in the
//      remote agent's prompt.
//
// The pan rides POINTER events under an explicit pointer capture, not touch
// events. A finger lands on a text span inside .xterm-rows, and the first tick
// makes the remote redraw the pane — which replaces that span. Touch events for
// a gesture keep going to their original target, so a listener on any ancestor
// goes deaf the moment that target is detached: the pane scrolls a line or two
// and then freezes mid-pan. Captured pointer events retarget to the mount
// element instead, which outlives every redraw.

import type { Terminal } from "@xterm/xterm";

/** Rows tmux's default wheel binding scrolls per tick. The pan step is sized
 *  from this so the text tracks the finger roughly 1:1 instead of racing it. */
const ROWS_PER_TICK = 5;
/** Floor for that step, for a pane too short to measure a sane row height. */
const MIN_STEP_PX = 40;
/** deltaY per synthetic tick: one notch, comfortably above one row height. */
const WHEEL_NOTCH_PX = 100;
/** Ticks per move, so a fast flick cannot flood the remote. */
const MAX_TICKS_PER_MOVE = 8;

export interface TerminalScrollOptions {
  /** True while the stream is a tmux attach (init_ack `tmux`). */
  isTmux: () => boolean;
}

/**
 * Wire touch scrolling + the wheel fallback onto a live terminal.
 * Returns a disposer.
 */
export function attachTerminalScrolling(
  term: Terminal,
  mount: HTMLElement,
  { isTmux }: TerminalScrollOptions
): () => void {
  // 'none' means the remote never asked for mouse reporting, so xterm.js will
  // fall through to its own (wrong, for us) wheel handling.
  const mouseReported = () => {
    try { return term.modes.mouseTrackingMode !== "none"; } catch { return false; }
  };

  // The wheel guard. xterm.js consults this handler on BOTH paths, so it must
  // stay out of the way whenever the remote is actually reporting mouse events.
  type WheelHandlerHost = {
    attachCustomWheelEventHandler?: (handler: (ev: WheelEvent) => boolean) => void;
  };
  const wheelHost = term as unknown as WheelHandlerHost;
  if (typeof wheelHost.attachCustomWheelEventHandler === "function") {
    wheelHost.attachCustomWheelEventHandler(() => {
      if (mouseReported()) return true;   // tmux mouse mode — let xterm report it
      if (isTmux()) return false;         // no way to scroll: swallow, never type
      return true;                        // a plain PTY: xterm's own handling is right
    });
  }

  // Wheel ticks are dispatched on the SCREEN element so they bubble to the
  // .xterm root, where xterm.js binds its mouse listeners.
  const screenEl = () => mount.querySelector<HTMLElement>(".xterm-screen") ?? mount;

  // One tick's worth of finger travel: five rows of THIS terminal, measured
  // rather than assumed, so it holds at any font size.
  const stepPx = () => {
    const rows = term.rows || 0;
    const height = mount.getBoundingClientRect().height;
    const rowHeight = rows > 0 && height > 0 ? height / rows : 0;
    return Math.max(MIN_STEP_PX, Math.round(rowHeight * ROWS_PER_TICK));
  };

  let pointerId: number | null = null;
  let anchorY = 0;
  let lastX = 0;

  const release = () => {
    if (pointerId === null) return;
    try { mount.releasePointerCapture(pointerId); } catch { /* already gone */ }
    pointerId = null;
  };

  const onPointerDown = (ev: PointerEvent) => {
    // A desktop mouse is already handled by xterm.js itself; only fingers (and
    // pens) need the bridge.
    if (ev.pointerType === "mouse" || !ev.isPrimary) return;
    release();
    pointerId = ev.pointerId;
    anchorY = ev.clientY;
    lastX = ev.clientX;
    try { mount.setPointerCapture(ev.pointerId); } catch { pointerId = null; }
  };

  const onPointerMove = (ev: PointerEvent) => {
    if (pointerId === null || ev.pointerId !== pointerId) return;
    // Finger up (y shrinks) = read forward = wheel down, so the sign carries
    // straight through to deltaY.
    const step = stepPx();
    const travel = anchorY - ev.clientY;
    const ticks = Math.trunc(travel / step);
    if (ticks === 0) return;
    anchorY -= ticks * step;
    lastX = ev.clientX;
    if (ev.cancelable) ev.preventDefault();
    const el = screenEl();
    const deltaY = ticks > 0 ? WHEEL_NOTCH_PX : -WHEEL_NOTCH_PX;
    const count = Math.min(Math.abs(ticks), MAX_TICKS_PER_MOVE);
    for (let i = 0; i < count; i++) {
      el.dispatchEvent(new WheelEvent("wheel", {
        deltaY,
        deltaMode: 0,
        clientX: lastX,
        clientY: ev.clientY,
        bubbles: true,
        cancelable: true
      }));
    }
  };

  const onPointerEnd = (ev: PointerEvent) => {
    if (pointerId !== null && ev.pointerId === pointerId) release();
  };

  // The pan belongs to the terminal, never to the page behind it — and without
  // this the browser claims the gesture and stops sending moves at all. Set
  // here rather than in either fitting's stylesheet so the behaviour and the
  // rule that makes it possible cannot drift apart.
  const priorTouchAction = mount.style.touchAction;
  mount.style.touchAction = "none";

  mount.addEventListener("pointerdown", onPointerDown);
  mount.addEventListener("pointermove", onPointerMove);
  mount.addEventListener("pointerup", onPointerEnd);
  mount.addEventListener("pointercancel", onPointerEnd);

  return () => {
    release();
    mount.style.touchAction = priorTouchAction;
    mount.removeEventListener("pointerdown", onPointerDown);
    mount.removeEventListener("pointermove", onPointerMove);
    mount.removeEventListener("pointerup", onPointerEnd);
    mount.removeEventListener("pointercancel", onPointerEnd);
  };
}

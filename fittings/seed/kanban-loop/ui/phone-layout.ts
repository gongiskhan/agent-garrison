// The phone layout switch and the column-carousel math behind the strip.
//
// One query, shared by the stylesheet's phone block and the components that
// change SHAPE on a phone (the topbar's overflow menu, the column strip), so
// the two can never disagree about where a phone begins.
import { useEffect, useState } from "react";

export const PHONE_LAYOUT_QUERY = "(max-width: 640px)";

export function usePhoneLayout(): boolean {
  const [phone, setPhone] = useState(
    () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(PHONE_LAYOUT_QUERY).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(PHONE_LAYOUT_QUERY);
    const onChange = () => setPhone(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return phone;
}

// The column the carousel is showing: the one whose snap offset is nearest the
// current scroll position. `offsets` are the scrollLeft values at which each
// column sits flush with the left edge, in board order.
export function activeColumnIndex(scrollLeft: number, offsets: number[]): number {
  let best = 0;
  let bestDist = Infinity;
  offsets.forEach((offset, i) => {
    const dist = Math.abs(offset - scrollLeft);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  });
  return best;
}

// Snap offsets for the columns of a scroller, measured from the first column
// so index 0 lands on scrollLeft 0 whatever padding the board carries.
export function columnOffsets(scroller: HTMLElement, columns: HTMLElement[]): number[] {
  if (columns.length === 0) return [];
  const origin = scroller.getBoundingClientRect().left - scroller.scrollLeft;
  const first = columns[0].getBoundingClientRect().left - origin;
  return columns.map((col) => col.getBoundingClientRect().left - origin - first);
}

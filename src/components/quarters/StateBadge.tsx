import type { PrimitiveState } from "@/lib/primitive-state";

// Text pill for a primitive's loose / owned / parked state, in the shipped
// .pill visual language (no emoji).
const TONE: Record<PrimitiveState, { cls: string; label: string }> = {
  owned: { cls: "verified", label: "owned" },
  loose: { cls: "warn", label: "loose" },
  parked: { cls: "idle", label: "parked" }
};

export function StateBadge({ state, drifted }: { state: PrimitiveState; drifted?: boolean }) {
  const tone = TONE[state];
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <span className={`pill ${tone.cls}`} style={{ fontSize: 10.5 }}>
        {tone.label}
      </span>
      {drifted ? (
        <span className="pill alarm" style={{ fontSize: 10.5 }} title="On-disk bytes differ from the lock">
          drifted
        </span>
      ) : null}
    </span>
  );
}

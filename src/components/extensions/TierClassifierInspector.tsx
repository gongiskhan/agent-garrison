import { Gauge, Route } from "lucide-react";

export default function TierClassifierInspector({
  config
}: {
  config: Record<string, string | number | boolean>;
}) {
  return (
    <div
      style={{
        display: "grid",
        gap: 14,
        gridTemplateColumns: "repeat(2, minmax(0, 1fr))"
      }}
    >
      <div style={{ border: "1px solid var(--rule)", background: "white", padding: 16 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 13,
            fontWeight: 600,
            color: "var(--ink)"
          }}
        >
          <Gauge size={16} />
          Tier floor
        </div>
        <div
          style={{
            marginTop: 12,
            fontSize: 32,
            fontWeight: 600,
            fontFamily: "var(--font-display), Georgia, serif",
            letterSpacing: "-0.005em",
            color: "var(--sage)"
          }}
        >
          {String(config.tier_floor ?? 3)}
        </div>
      </div>
      <div style={{ border: "1px solid var(--rule)", background: "white", padding: 16 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 13,
            fontWeight: 600,
            color: "var(--ink)"
          }}
        >
          <Route size={16} />
          Routing rule
        </div>
        <p
          style={{
            marginTop: 12,
            fontSize: 13,
            lineHeight: 1.6,
            color: "var(--mute)"
          }}
        >
          T{String(config.plan_threshold ?? 3)} and above requires plan, reclassify, then route.
        </p>
      </div>
    </div>
  );
}

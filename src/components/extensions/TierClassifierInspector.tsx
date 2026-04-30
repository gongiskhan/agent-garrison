import { Gauge, Route } from "lucide-react";

export default function TierClassifierInspector({
  config
}: {
  config: Record<string, string | number | boolean>;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="border border-[#d9d1c2] bg-white p-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Gauge size={16} />
          Tier floor
        </div>
        <div className="mt-3 text-4xl font-semibold text-signal">{String(config.tier_floor ?? 3)}</div>
      </div>
      <div className="border border-[#d9d1c2] bg-white p-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Route size={16} />
          Routing rule
        </div>
        <p className="mt-3 text-sm leading-6 text-ink/75">
          T{String(config.plan_threshold ?? 3)} and above requires plan, reclassify, then route.
        </p>
      </div>
    </div>
  );
}

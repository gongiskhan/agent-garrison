import { Suspense } from "react";
import { StationGrid } from "@/components/compose/StationGrid";

export default function ComposePage() {
  return (
    <Suspense
      fallback={
        <main>
          <div className="page">
            <div className="head">
              <h1>Loading composition…</h1>
            </div>
          </div>
        </main>
      }
    >
      <StationGrid />
    </Suspense>
  );
}

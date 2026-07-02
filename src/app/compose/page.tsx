import { Suspense } from "react";
import { StationGrid } from "@/components/compose/StationGrid";
import { PageSkeleton } from "@/components/chrome/PageSkeleton";

export default function ComposePage() {
  return (
    <Suspense fallback={<PageSkeleton label="Loading composition" />}>
      <StationGrid />
    </Suspense>
  );
}

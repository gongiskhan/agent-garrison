import { Suspense } from "react";
import { StationGrid } from "@/components/compose/StationGrid";
import { PageSkeleton } from "@/components/chrome/PageSkeleton";
import { RuntimeDegradationNotice } from "@/components/compose/RuntimeDegradationNotice";

export default function ComposePage() {
  return (
    <Suspense fallback={<PageSkeleton label="Loading composition" />}>
      <RuntimeDegradationNotice />
      <StationGrid />
    </Suspense>
  );
}

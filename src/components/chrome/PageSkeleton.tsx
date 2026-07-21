import { GarrisonMark } from "./GarrisonMark";

// Shared loading state for shell pages: a quiet skeleton in place of the raw
// "Loading..." headline, so route transitions read as the page taking shape
// rather than the app being empty.
export function PageSkeleton({ label }: { label: string }) {
  return (
    <main>
      <div className="page route-skeleton" aria-busy="true" aria-label={label}>
        <div className="route-skeleton-head">
          <GarrisonMark className="route-skeleton-mark" aria-hidden="true" />
          <div className="head">
            <span className="route-skeleton-kicker">Operations room</span>
            <div className="skeleton-line skeleton-line-title" />
            <div className="skeleton-line skeleton-line-copy" />
          </div>
        </div>
        <div className="skeleton-grid">
          <div className="skeleton-card" />
          <div className="skeleton-card" />
          <div className="skeleton-card" />
        </div>
        <span className="visually-hidden">{label}</span>
      </div>
    </main>
  );
}

// Shared loading state for shell pages: a quiet skeleton in place of the raw
// "Loading..." headline, so route transitions read as the page taking shape
// rather than the app being empty.
export function PageSkeleton({ label }: { label: string }) {
  return (
    <main>
      <div className="page" aria-busy="true" aria-label={label}>
        <div className="head">
          <div className="skeleton-line" style={{ width: "min(130px, 40%)", height: 11, marginBottom: 18 }} />
          <div className="skeleton-line" style={{ width: "min(340px, 75%)", height: 34, marginBottom: 12 }} />
          <div className="skeleton-line" style={{ width: "min(460px, 95%)", height: 14 }} />
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

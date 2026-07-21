import type { ReactNode } from "react";
import { GarrisonMark } from "./GarrisonMark";

export function RouteState({
  code,
  eyebrow,
  title,
  children,
  actions
}: {
  code: string;
  eyebrow: string;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <main className="route-state-shell">
      <section className="route-state" aria-labelledby="route-state-title">
        <div className="route-state-seal" aria-hidden="true">
          <GarrisonMark />
        </div>
        <div className="route-state-meta">
          <span>{eyebrow}</span>
          <span>{code}</span>
        </div>
        <h1 id="route-state-title">{title}</h1>
        <div className="route-state-copy">{children}</div>
        {actions ? <div className="route-state-actions">{actions}</div> : null}
      </section>
    </main>
  );
}

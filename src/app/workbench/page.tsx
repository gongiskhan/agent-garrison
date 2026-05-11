"use client";

import { Suspense } from "react";
import { WorkbenchPanel } from "@/components/workbench/WorkbenchPanel";

export default function WorkbenchPage() {
  return (
    <Suspense
      fallback={
        <main>
          <div className="page wide">
            <div className="head">
              <h1>Loading Workbench…</h1>
            </div>
          </div>
        </main>
      }
    >
      <WorkbenchPanel />
    </Suspense>
  );
}

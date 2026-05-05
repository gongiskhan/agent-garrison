"use client";

import { Suspense } from "react";
import { ArmoryPanel } from "@/components/armory/ArmoryPanel";

export default function ArmoryPage() {
  return (
    <Suspense
      fallback={
        <main>
          <div className="page wide">
            <div className="head">
              <h1>Loading Armory…</h1>
            </div>
          </div>
        </main>
      }
    >
      <ArmoryPanel />
    </Suspense>
  );
}

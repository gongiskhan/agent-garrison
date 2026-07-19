"use client";

import { useEffect } from "react";
import Link from "next/link";
import { RouteState } from "@/components/chrome/RouteState";

export default function ErrorPage({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <RouteState
      code={error.digest ? `Fault ${error.digest}` : "System fault"}
      eyebrow="Command interrupted"
      title="The operation could not be completed."
      actions={
        <>
          <button className="btn primary" type="button" onClick={reset}>
            Retry operation
          </button>
          <Link className="btn ghost" href="/">
            Return to Garrison
          </Link>
        </>
      }
    >
      <p>
        Garrison contained the fault before it reached the rest of the command
        surface. Retry the operation, or return home and approach it again.
      </p>
    </RouteState>
  );
}

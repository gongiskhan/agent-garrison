import Link from "next/link";
import { RouteState } from "@/components/chrome/RouteState";

export default function NotFound() {
  return (
    <RouteState
      code="404"
      eyebrow="Uncharted sector"
      title="This post is beyond the walls."
      actions={
        <>
          <Link className="btn primary" href="/">
            Return to Garrison
          </Link>
          <Link className="btn ghost" href="/muster">
            Open composition
          </Link>
        </>
      }
    >
      <p>
        The requested route is not stationed in this Garrison. Check the address,
        or return to the operations room to choose another post.
      </p>
    </RouteState>
  );
}

import type { SVGProps } from "react";

/**
 * The Garrison battlement, kept deliberately monochrome so every shell
 * surface can set its own command-state colour through `currentColor`.
 */
export function GarrisonMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 80 80" fill="none" focusable="false" {...props}>
      <path
        d="M14 24 19 18 24 24v40H14V24Zm14-4 5-6 5 6v44H28V20Zm14 4 5-6 5 6v40H42V24Zm14-4 5-6 5 6v44H56V20Z"
        fill="currentColor"
      />
      <path d="M10 41.5h60" stroke="currentColor" strokeWidth="3" opacity=".52" />
    </svg>
  );
}

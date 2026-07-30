"use client";

import type { FittingViewProps } from "../registry";
import { MarkdownPayloadView } from "./MarkdownPayloadView";

// `garrison:skill` — every skill-carrying Fitting's view: edit each skill's
// SKILL.md (frontmatter form + markdown body), autosaved to the seed files.
export default function SkillView(props: FittingViewProps) {
  return (
    <MarkdownPayloadView
      {...props}
      kindLabel="skill"
      roots={[{ dir: ".apm/skills", perDoc: "subdir" }]}
    />
  );
}

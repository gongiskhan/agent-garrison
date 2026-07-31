"use client";

import type { FittingViewProps } from "../registry";
import { MarkdownPayloadView } from "./MarkdownPayloadView";

// `garrison:skill` — every skill-carrying Fitting's view: edit each skill's
// SKILL.md (frontmatter form + markdown body), autosaved to the seed files.
//
// Two roots, same `<dir>/<name>/SKILL.md` shape. `.apm/skills` is what APM
// deploys. `skill-variants` is for a Fitting that ships MORE THAN ONE version of
// the same skill and picks between them at setup time (basic-memory installs a
// local or a remote-CLI variant depending on its `backend` key). Such a variant
// must NOT sit under .apm/skills, or APM would deploy every variant into the
// session at once — but it still has to be editable from the Fitting's own view
// instead of only through the generic file editor. `discoverDocs` skips a root a
// Fitting does not have, so this is inert for every other skill Fitting.
export default function SkillView(props: FittingViewProps) {
  return (
    <MarkdownPayloadView
      {...props}
      kindLabel="skill"
      roots={[
        { dir: ".apm/skills", perDoc: "subdir" },
        { dir: "skill-variants", perDoc: "subdir" }
      ]}
    />
  );
}

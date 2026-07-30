"use client";

import type { FittingViewProps } from "../registry";
import { MarkdownPayloadView } from "./MarkdownPayloadView";

// `garrison:prompt` — system-prompt Fittings: edit the prompt markdown
// (.apm/prompts/*.md, plus payload/*.md for persona-style Fittings).
export default function PromptView(props: FittingViewProps) {
  return (
    <MarkdownPayloadView
      {...props}
      kindLabel="prompt"
      roots={[
        { dir: ".apm/prompts", perDoc: "file" },
        { dir: "payload", perDoc: "file" }
      ]}
    />
  );
}

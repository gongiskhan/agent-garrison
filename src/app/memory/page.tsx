import { permanentRedirect } from "next/navigation";

// "Memory" was renamed to "Context" (CLAUDE.md) under the Quarters pivot — the
// word "Memory" is reserved for the faculty/compiler that PRODUCES the document.
// The old Save-button editor (MemoryPanel) is retired; /memory now permanently
// redirects to the autosave Context surface. Kept as a back-compat 308 for any
// bookmarks / external links.
export default function MemoryPage() {
  permanentRedirect("/quarters/context");
}

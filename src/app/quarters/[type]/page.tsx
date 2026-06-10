import { notFound } from "next/navigation";
import { categoryBySlug } from "@/components/quarters/quartersTypes";
import { SettingsPanel } from "@/components/settings/SettingsPanel";
import { ContextPanel } from "@/components/quarters/ContextPanel";
import { PlansPanel } from "@/components/quarters/PlansPanel";
import { PrimitiveListPanel } from "@/components/quarters/PrimitiveListPanel";
import { ReadOnlyNotePanel } from "@/components/quarters/ReadOnlyNotePanel";
import { ReadOnlyTailPanel } from "@/components/quarters/ReadOnlyTailPanel";

export default function QuartersTypePage({ params }: { params: { type: string } }) {
  const cat = categoryBySlug(params.type);
  if (!cat) notFound();

  if (cat.slug === "settings") return <SettingsPanel />;
  if (cat.slug === "context") return <ContextPanel />;
  if (cat.slug === "plans") return <PlansPanel />;
  if (cat.slug === "logs") return <ReadOnlyTailPanel category="logs" />;
  if (cat.slug === "sessions") return <ReadOnlyTailPanel category="sessions" />;
  if (cat.kind === "primitives") return <PrimitiveListPanel cat={cat} />;
  return <ReadOnlyNotePanel cat={cat} />;
}

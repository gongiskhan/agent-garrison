import { notFound } from "next/navigation";
import { getPromotedFitting } from "@/lib/promoted-fittings";
import { PromotedFittingDetail } from "@/components/fitting-views/PromotedFittingDetail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Detail view for a promoted Fitting (a Claude Code primitive surfaced as a
// first-class Fitting). The static `promoted` segment takes priority over the
// sibling catch-all /fitting/[fittingId]/[[...rest]], so this never collides
// with a library-fitting id.
export default async function PromotedFittingPage({ params }: { params: { id: string } }) {
  const fitting = await getPromotedFitting(params.id);
  if (!fitting) notFound();
  return <PromotedFittingDetail fitting={fitting} />;
}

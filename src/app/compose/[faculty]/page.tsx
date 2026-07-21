import { notFound, redirect } from "next/navigation";
import { FacultyStation } from "@/components/compose/FacultyStation";
import { facultyIds, type FacultyId } from "@/lib/types";

// D12 - the separate Orchestrator and Runtimes stations fold into the Muster
// page: the Orchestrator prompt is edited in Muster's Orchestrator panel and the
// engines live in its Standing Fittings. Those two faculty drilldowns redirect to
// /muster; every other faculty station keeps its own /compose/<faculty> view.
const FOLDED_INTO_MUSTER = new Set<FacultyId>(["orchestrator", "runtimes"]);

export default function FacultyPage({
  params
}: {
  params: { faculty: string };
}) {
  const { faculty } = params;
  if (!facultyIds.includes(faculty as FacultyId)) {
    notFound();
  }
  if (FOLDED_INTO_MUSTER.has(faculty as FacultyId)) {
    redirect("/muster");
  }
  return <FacultyStation facultyId={faculty as FacultyId} />;
}

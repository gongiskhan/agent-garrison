import { notFound } from "next/navigation";
import { FacultyStation } from "@/components/compose/FacultyStation";
import { facultyIds, type FacultyId } from "@/lib/types";

export default function FacultyPage({
  params
}: {
  params: { faculty: string };
}) {
  const { faculty } = params;
  if (!facultyIds.includes(faculty as FacultyId)) {
    notFound();
  }
  return <FacultyStation facultyId={faculty as FacultyId} />;
}

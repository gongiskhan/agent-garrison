import { FittingSurfacePanel } from "@/components/fitting-views/FittingSurfacePanel";
import {redirect} from 'next/navigation';
import {legacyDocumentRedirect} from '@/lib/archive-legacy';

export default async function FittingSurfacePage({params}:{params:Promise<{fittingId:string;rest?:string[]}>}) {
  const route=await params;
  if(route.fittingId==='documents')redirect(route.rest?.[0]?await legacyDocumentRedirect(route.rest[0]):'/archive');
  return <FittingSurfacePanel />;
}

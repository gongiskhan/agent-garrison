import { MeshPanel } from "@/components/mesh/MeshPanel";
import Link from "next/link";
import {ChevronRight, FolderGit2} from "lucide-react";
import {PROJECTS_LABEL} from "@garrison/projects/label";

export default function MeshPage() {
  return (
    <>
      <MeshPanel />
      <div className="page"><Link href="/projects" style={{display: 'flex', alignItems: 'center', gap: 'var(--space-3)', minHeight: 'var(--row-target)', padding: 'var(--space-3)', border: '1px solid var(--rule)'}}><FolderGit2 size={20}/><span style={{flex: 1}}>{PROJECTS_LABEL}</span><ChevronRight size={18}/></Link></div>
    </>
  );
}

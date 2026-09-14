"use client";
import {ProjectsHost as ProjectsApp} from '../../../packages/projects/ui/app';
import {renderMarkdown} from '@/lib/markdown';
import {NodeChip} from '@/components/mesh/NodeChip';
import '../../../packages/projects/ui/projects.css';
const bridge = {render: (source: string) => renderMarkdown(source, {wikiLinks: false}), NodeChip};
export function ProjectsHost({view}: {view: string[]}) {return <ProjectsApp view={view} bridge={bridge}/>;}

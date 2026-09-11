"use client";
import {ArchiveApp} from '../../../packages/archive/ui/app';
import {QuartersDrawer} from '../../components/quarters/QuartersDrawer';
import {ConfirmDialog} from '../../components/quarters/ConfirmDialog';
import {renderMarkdown} from '../../lib/markdown';
import '../../../packages/archive/ui/archive.css';
const bridge={Drawer:QuartersDrawer,Confirm:ConfirmDialog,render:renderMarkdown};
export function ArchiveHost({view}:{view:string}){return <ArchiveApp view={view} bridge={bridge}/>;}

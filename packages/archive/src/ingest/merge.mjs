import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseFrontmatter} from '../frontmatter.mjs';

// Git may receive independently generated extractions of the same source from
// two nodes. Select one complete extraction; never splice their text together.
export function mergeDerived({base='',ours,theirs,file}){
 const parsed=[base,ours,theirs].map(raw=>parseFrontmatter(raw));
 if(!parsed.some(p=>p.frontmatter.garrison==='derived'))return {kind:'text'};
 const parts=file.split('/');
 if(parts[0]!=='Archive'||parts.some(p=>p.startsWith('.')||!p)||!file.endsWith('.md'))return {kind:'conflict'};
 const source=path.posix.basename(file).slice(0,-3),a=parsed[1],b=parsed[2];
 const sameName=value=>typeof value==='string'&&value.normalize('NFC')===source.normalize('NFC');
 const valid=p=>!p.parseWarning&&p.frontmatter.garrison==='derived'&&sameName(p.frontmatter.source)&&typeof p.frontmatter.sha256==='string'&&/^[a-f0-9]{64}$/.test(p.frontmatter.sha256)&&['ok','unsupported','failed'].includes(p.frontmatter.status)&&typeof p.frontmatter.generated==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(p.frontmatter.generated)&&Number.isFinite(Date.parse(p.frontmatter.generated));
 if(!valid(a)||!valid(b)||a.frontmatter.sha256!==b.frontmatter.sha256)return {kind:'conflict'};
 if(base&&(!parsed[0].frontmatter||parsed[0].parseWarning||parsed[0].frontmatter.garrison!=='derived'||!sameName(parsed[0].frontmatter.source)))return {kind:'conflict'};
 const rank={ok:3,unsupported:2,failed:1};
 const candidates=[{raw:ours,meta:a.frontmatter},{raw:theirs,meta:b.frontmatter}];
 const hash=raw=>createHash('sha256').update(raw).digest('hex');
 candidates.sort((x,y)=>rank[y.meta.status]-rank[x.meta.status]||Date.parse(y.meta.generated)-Date.parse(x.meta.generated)||hash(x.raw).localeCompare(hash(y.raw),'en'));
 return {kind:'derived',content:candidates[0].raw};
}

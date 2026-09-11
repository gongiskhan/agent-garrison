import path from 'node:path';
import { sanitizeName, visibleName } from '../paths.mjs';
import { commentDate } from '../card.mjs';

export const isSensitive = text => /cartão|cartao|cidadão|cidadao|passaporte|passport|nif|niss|seguro|insurance|banco|bank|iban|password|palavra-passe/i.test(text);
export function trelloHosted(url){try{const host=new URL(url).hostname;return host==='trello.com'||host.endsWith('.trello.com');}catch{return false;}}
function customValue(field,item){if(item.value){const value=Object.values(item.value)[0];return value===undefined?null:String(value);}const option=field?.options?.find(o=>o.id===item.idValue);return option?.value?.text??null;}
export function mapBoard(board,{includeArchived=false,maxFileMb=25,targetPrefix='',credentials=true}={}){
  const usedLists=new Set();const claim=(title,used)=>{const base=sanitizeName(title);let name=base,n=2;while(used.has(name.toLocaleLowerCase('pt-PT')))name=`${base} (${n++})`;used.add(name.toLocaleLowerCase('pt-PT'));return name;};
  const lists=[];const counts={lists:0,cards:0,comments:0,attachments:0,oversize:0,links:0};
  for(const [li,list]of [...(board.lists??[])].filter(l=>includeArchived||!l.closed).sort((a,b)=>a.pos-b.pos).entries()){
    const relative=path.posix.join('Archive',targetPrefix?sanitizeName(targetPrefix):'',claim(list.name,usedLists));const cards=[];const usedCards=new Set();
    for(const [ci,card]of [...(board.cards??[])].filter(c=>c.idList===list.id&&(includeArchived||!c.closed)).sort((a,b)=>a.pos-b.pos).entries()){
      const tags=(card.labels??[]).map(l=>l.name||`label:${l.color??'none'}`);if(card.closed)tags.push('archived');
      const attachments=[],links=[];const usedFiles=new Set(['index.md','_list.md']);
      for(const att of card.attachments??[]){
        const oversize=att.bytes>maxFileMb*1024*1024;const hosted=trelloHosted(att.url)&&att.isUpload!==false;
        if(!hosted||oversize||!credentials||!visibleName(sanitizeName(att.name))){links.push({title:att.name+(oversize?` (too large: ${Math.round(att.bytes/1024/1024)} MB)`:''),url:att.url});counts.links++;if(oversize)counts.oversize++;}
        else {const ext=path.extname(att.name),stem=sanitizeName(path.basename(att.name,ext));let name=stem+ext,n=2;while(usedFiles.has(name)||usedFiles.has(name+'.md'))name=`${stem} (${n++})${ext}`;usedFiles.add(name);attachments.push({id:att.id,name,url:att.url,size:att.bytes??0,mime:att.mimeType??null});counts.attachments++;}
      }
      const cover=attachments.find(a=>a.id===card.cover?.idAttachment&&/^image\//.test(a.mime??''))??(!card.cover?.idAttachment?attachments.find(a=>/^image\//.test(a.mime??'')||/\.(jpe?g|png|webp|gif)$/i.test(a.name)):null);
      const actions=(board.actions??[]).filter(a=>a.type==='commentCard'&&a.data?.card?.id===card.id).concat((card.actions??[]).filter(a=>a.type==='commentCard'));
      const unique=[...new Map(actions.map(a=>[a.id,a])).values()];
      const comments=unique.sort((a,b)=>b.date.localeCompare(a.date)).map(a=>({at:commentDate(a.date),author:a.memberCreator?.fullName??'Trello',markdown:a.data.text??''}));counts.comments+=comments.length;
      const checklistSources=card.checklists?.length?card.checklists:(board.checklists??[]).filter(c=>c.idCard===card.id||card.idChecklists?.includes(c.id));
      const checklists=checklistSources.filter(c=>typeof c==='object').sort((a,b)=>(a.pos??0)-(b.pos??0)).map(c=>({title:c.name,items:[...(c.checkItems??[])].sort((a,b)=>a.pos-b.pos).map(i=>({text:i.name,done:i.state==='complete'}))}));
      const details=(card.customFieldItems??[]).map(item=>{const field=board.customFields?.find(f=>f.id===item.idCustomField);return {label:field?.name??item.idCustomField,value:customValue(field,item)};}).filter(f=>f.value!==null);
      const created=/^[a-f0-9]{8}/i.test(card.id)?new Date(parseInt(card.id.slice(0,8),16)*1000).toISOString():card.dateLastActivity;
      const meta={garrison:'card',title:card.name,...(cover?{cover:cover.name}:{}),tags,order:(ci+1)*10,created,updated:card.dateLastActivity??created,source:`trello:${card.id}`,...(card.due?{due:card.due.slice(0,10)}:{}),sensitive:isSensitive(`${list.name} ${card.name}`)};
      cards.push({path:path.posix.join(relative,claim(card.name,usedCards)),frontmatter:meta,description:card.desc??'',details,links,checklists,comments,attachments});counts.cards++;
    }
    lists.push({path:relative,title:list.name,order:(li+1)*10,cards});counts.lists++;
  }
  return {id:board.id,shortLink:board.shortLink??board.id,name:board.name,lists,counts};
}

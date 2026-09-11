#!/usr/bin/env node
// Deterministic, synthetic documents only. No personal material is an input.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { stringify } from 'yaml';

const root = path.dirname(fileURLToPath(import.meta.url));
const at = '2026-09-11T10:12:00+01:00';
const put = (name, data) => { const p = path.join(root, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
const markdown = (meta, body) => `---\n${stringify(meta)}---\n${body}\n`;
const xml = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
const labels = ['SYNTHETIC SAMPLE - NOT VALID', 'Document: Archive test certificate', 'Holder: Alex Example', 'Reference: TEST-48392017', 'Expiry: 01 03 2027'];
for (let i = 0; i < 3; i++) {
  const name = ['sample-document', 'sample-house', 'sample-receipt'][i];
  const lines = i === 0 ? labels : ['SYNTHETIC SAMPLE - NOT VALID', i === 1 ? 'House maintenance' : 'Receipt for test materials', 'Reference: FIXTURE-2026-' + (i + 1), 'Amount: 42.00 EUR'];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="640"><rect width="1000" height="640" fill="${['#f3ead7','#e6efe7','#ebe8f2'][i]}"/><rect x="40" y="40" width="920" height="560" rx="20" fill="white" stroke="#b9b0a0"/>${lines.map((line,j)=>`<text x="75" y="${115+j*85}" font-family="DejaVu Sans" font-size="${j===0?30:32}" fill="#242424">${xml(line)}</text>`).join('')}</svg>`;
  put(name + '.svg', svg);
  execFileSync('convert', [path.join(root,name+'.svg'), '-quality', '90', path.join(root,name+'.jpg')]);
}

// Minimal portable PDF writer: one text-layer PDF and a three-page image PDF.
function pdf(scanned) {
  const objects = []; const add = (v) => { objects.push(v); return objects.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>'); add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const jpg = fs.readFileSync(path.join(root,'sample-document.jpg'));
  const stream = (header, bytes) => Buffer.concat([Buffer.from(`<< ${header} /Length ${bytes.length} >>\nstream\n`), bytes, Buffer.from('\nendstream')]);
  const image = scanned ? add(stream('/Type /XObject /Subtype /Image /Width 1000 /Height 640 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode', jpg)) : null;
  const pages = [];
  for(let n=1;n<=(scanned?3:1);n++) {
    const content = scanned ? 'q 560 0 0 358 20 220 cm /Im1 Do Q' : `BT /F1 18 Tf 45 720 Td ${labels.map((l,i)=>`${i?'0 -40 Td ':''}(${l}) Tj`).join('\n')} ET`;
    const contents = add(stream('', Buffer.from(content)));
    pages.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 ${font} 0 R >> ${image?`/XObject << /Im1 ${image} 0 R >>`:''} >> /Contents ${contents} 0 R >>`));
  }
  objects[1] = `<< /Type /Pages /Kids [${pages.map(p=>p+' 0 R').join(' ')}] /Count ${pages.length} >>`;
  let out = Buffer.from('%PDF-1.4\n'); const offsets = [0];
  objects.forEach((o,i)=>{ offsets.push(out.length); out=Buffer.concat([out,Buffer.from(`${i+1} 0 obj\n`),Buffer.from(o),Buffer.from('\nendobj\n')]); });
  const xref=out.length;
  return Buffer.concat([out,Buffer.from(`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)]);
}
put('sample-text.pdf',pdf(false)); put('sample-scanned.pdf',pdf(true));

const sidecar = (source, kind='image') => markdown({garrison:'derived',source,sha256:'fixture',kind,pages:kind==='pdf'?3:1,generated:at,target:'fixture',status:'ok'},`# ${source}\n\n## What it is\nA synthetic sample certificate for testing.\n\n## Text\n${labels.join('\n')}\n\n## Fields\n- Document type: Test certificate\n- Holder: Alex Example\n- Document number: TEST-48392017`);
const attachment = (folder, name, source=name, kind='image') => { put(`${folder}/${name}`,fs.readFileSync(path.join(root,source))); put(`${folder}/${name}.md`,sidecar(name,kind)); };
const lists = ['Personal documents','House','Finance'];
const titles = [['Cartão de Cidadão','Seguro de saúde','Travel checklist'],['House maintenance','Kitchen receipts'],['Annual budget','Bank details']];
for(let l=0;l<3;l++) {
  const folder=`vault/Archive/${lists[l]}`; put(`${folder}/_list.md`,markdown({garrison:'list',title:lists[l],order:(l+1)*10},''));
  for(let c=0;c<titles[l].length;c++) {
    const title=titles[l][c]; const dir=`${folder}/${title}`;
    const meta={garrison:'card',title,cover:'sample-document.jpg',tags:['fixture',l===0?'documentos':'home'],order:(c+1)*10,created:at,updated:at,sensitive:l===0&&c<2};
    let body='Synthetic fixture. Keep the original in the sample folder.';
    if(c===2) body+='\n\n## Links\n- [Example portal](https://example.com/)\n\n## Checklists\n### Preparation\n- [ ] Book appointment\n- [x] Gather documents';
    if(c===0) body+='\n\n## Comments\n'+[11,10,9].map(day=>`### 2026-09-${day} 10:14 · Gonçalo\nSynthetic comment ${day}.`).join('\n');
    put(`${dir}/index.md`,markdown(meta,body)); attachment(dir,'sample-document.jpg');
    if(l===0&&c===1) attachment(dir,'sample-text.pdf','sample-text.pdf','pdf');
  }
}
attachment('vault/Archive/Inbox','sample-document.jpg');
for(const [folder,names] of [['Memory',['Welcome','Reading notes']],['Projects/Garrison/Memory',['Architecture','Operations']],['Projects/Garrison/Memory/Claude Native',['Mirror']]]) {
  for(const title of names) put(`vault/${folder}/${title}.md`,markdown({title,type:'note',permalink:title.toLowerCase().replaceAll(' ','-'),tags:['fixture']},`# ${title}\n\nSynthetic memory used only by automated tests.\n\n## Details\n- First sample point\n- Second sample point\n\nSee [[Architecture]] and [sample card](garrison://archive/Archive/House/House%20maintenance).`));
}
// Correct fixture hashes make prewritten sidecars authoritative on boot.
const {createHash}=await import('node:crypto');
function hashes(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())hashes(p);else if(e.name.endsWith('.md')){const raw=fs.readFileSync(p,'utf8');if(raw.includes('sha256: fixture'))fs.writeFileSync(p,raw.replace('sha256: fixture','sha256: '+createHash('sha256').update(fs.readFileSync(p.slice(0,-3))).digest('hex')));}}}
hashes(path.join(root,'vault'));

const board={id:'64f100000000000000000000',name:'Synthetic documents',shortLink:'Fixture9',lists:[],cards:[],actions:[],checklists:[],customFields:[{id:'field1',name:'Reference',type:'text'}]};
for(let l=0;l<3;l++) {
  const idList=`list${l+1}`; board.lists.push({id:idList,name:lists[l],pos:(l+1)*16384,closed:false});
  for(let c=0;c<3;c++) {
    const i=l*3+c,id=`64f1${String(i).padStart(20,'0')}`;
    const name=i===0?'Cartão de Cidadão':i===4?'Kitchen / repairs':`Fixture card ${i+1}`;
    const att={id:`att${i}`,name:'sample-document.jpg',url:`https://trello.com/1/cards/${id}/attachments/att${i}/download/sample-document.jpg`,bytes:12000,mimeType:'image/jpeg',isUpload:true};
    const card={id,idBoard:board.id,idList,name,desc:`Synthetic description ${i+1}.`,pos:(c+1)*16384,dateLastActivity:at,due:i===0?'2027-03-01T12:00:00Z':null,closed:i===8,labels:[{name:'fixture',color:'green'},...(i===1?[{name:'',color:'blue'}]:[])],attachments:[att],cover:{idAttachment:att.id},checklists:[],customFieldItems:i===0?[{idCustomField:'field1',value:{text:'FAKE-2026'}}]:[]};
    if(i===1)card.attachments.push({id:'external',name:'Portal',url:'https://example.com/',bytes:0,isUpload:false});
    if(i===2)card.attachments.push({id:'oversize',name:'large.pdf',url:'https://trello.com/large.pdf',bytes:30*1024*1024,mimeType:'application/pdf',isUpload:true});
    if(i===3){const checklist={id:'check1',idCard:id,name:'Preparation',pos:10,checkItems:[{id:'item1',name:'First item',state:'incomplete',pos:10},{id:'item2',name:'Second item',state:'complete',pos:20}]};card.checklists.push(checklist);board.checklists.push(checklist);}
    for(let n=0;n<(i===0?3:1);n++)board.actions.push({id:`comment${i}-${n}`,type:'commentCard',date:`2026-09-${String(11-n).padStart(2,'0')}T10:14:00Z`,memberCreator:{fullName:'Gonçalo'},data:{card:{id},text:`Synthetic comment ${n+1}`}});
    board.cards.push(card);
  }
}
put('trello-board.json',JSON.stringify(board,null,2)+'\n');
console.log('Synthetic Archive fixtures generated.');

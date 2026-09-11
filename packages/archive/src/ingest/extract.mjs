import fs from 'node:fs/promises';
import path from 'node:path';
import { confine } from '../paths.mjs';
import { sourceHash, writeSidecar } from './sidecar.mjs';
import { documentSchema, EXTRACT_PROMPT } from './look.mjs';
import { binary, run, imageForModel, tempDir, pdfHint } from './binaries.mjs';

export function kindOf(name){const ext=path.extname(name).toLowerCase();return /\.(png|jpe?g|webp|gif|bmp|avif|heic|heif)$/.test(ext)?'image':ext==='.pdf'?'pdf':/\.(txt|csv|json|log|yml|yaml)$/.test(ext)?'text':/\.(docx|xlsx|pptx)$/.test(ext)?'office':/\.(mp3|wav|m4a|ogg|aac|flac)$/.test(ext)?'audio':'other';}
export async function extract(ctx,relative,{beforeModel=async()=>{},look=ctx.look}={}){
  const full=confine(ctx.vaultDir,relative),kind=kindOf(relative),hash=await sourceHash(ctx,relative);const result={kind,sha256:hash,status:'ok',pages:1,target:ctx.config.extract_target};let temp;
  const observe=async(images)=>{await beforeModel();return (await look({imagePaths:images,prompt:EXTRACT_PROMPT,schema:documentSchema,target:ctx.config.extract_target,beforeRetry:beforeModel})).json;};
  try{
    if(kind==='text'){const file=await fs.open(full,'r');const buffer=Buffer.alloc(200*1024);try{const {bytesRead}=await file.read(buffer,0,buffer.length,0);result.text=buffer.subarray(0,bytesRead).toString('utf8');}finally{await file.close();}result.what_it_is=`Text file, ${result.text.split('\n').length} lines`;result.fields=[];}
    else if(kind==='image'){
      temp=tempDir();Object.assign(result,await observe([await imageForModel(full,temp)]));
    }else if(kind==='pdf'){
      const textTool=binary('pdftotext'),renderTool=binary('pdftoppm');if(!textTool&&!renderTool)throw new Error('pdftotext/pdftoppm not installed. '+pdfHint());
      const info=binary('pdfinfo');let pages=1;if(info){const {stdout}=await run(info,[full]);pages=Number(/^Pages:\s+(\d+)/m.exec(stdout)?.[1]??1);}result.pages=pages;
      let text='';if(textTool)text=(await run(textTool,['-layout',full,'-'],{maxBuffer:20*1024*1024})).stdout;
      if(!info)pages=Math.max(1,text.split('\f').length-1);result.pages=pages;
      if(text.replace(/\s/g,'').length/pages>=50){result.what_it_is=`PDF document, ${pages} pages`;result.text=text;result.fields=[];}
      else {
        if(!renderTool)throw new Error('pdftoppm not installed. '+pdfHint());temp=tempDir();const cap=Math.min(pages,ctx.config.pdf_max_pages);
        await run(renderTool,['-r','110','-png','-f','1','-l',String(cap),full,path.join(temp,'page')],{maxBuffer:1024*1024});
        const images=(await fs.readdir(temp)).filter(n=>n.endsWith('.png')).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).map(n=>path.join(temp,n));
        const texts=[],what=[],fields=[];
        // One page per call preserves exact page attribution; it is a permitted
        // batch size (at most four) and never invents page boundaries.
        for(let i=0;i<images.length;i++){const r=await observe([images[i]]);texts.push(`### Page ${i+1}\n${r.text}`);what.push(r.what_it_is);fields.push(...r.fields);if(r.confidence<0.4)result.confidence=0.3;}
        result.text=texts.join('\n\n');result.what_it_is=[...new Set(what)].join(' ')+(pages>cap?` Only the first ${cap} of ${pages} pages were extracted.`:'');result.fields=fields;
      }
    }else if(kind==='office'&&/\.docx$/i.test(relative)&&binary('pandoc')){result.text=(await run(binary('pandoc'),['-t','plain',full],{maxBuffer:20*1024*1024})).stdout;result.what_it_is='Word document';result.fields=[];}
    else result.status='unsupported';
    if(result.confidence<0.4)result.fields=[{label:'Confidence',value:'low'},...(result.fields??[])];
  }catch(error){if(error.hourlyLimit)throw error;result.status='failed';result.error=error.message;}
  finally{if(temp)await fs.rm(temp,{recursive:true,force:true});}
  // A source changed during the model call: never label old extraction current.
  if(await sourceHash(ctx,relative)!==hash)throw new Error('Source changed during extraction');
  await writeSidecar(ctx,relative,result);return result;
}

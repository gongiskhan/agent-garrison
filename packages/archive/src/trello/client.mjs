import { setTimeout as delay } from 'node:timers/promises';
import { trelloHosted, mapBoard } from './mapper.mjs';

export class TrelloClient {
  constructor({key,token,fetchImpl=fetch,base='https://api.trello.com/1',sleep=(ms,signal)=>delay(ms,undefined,{signal}),log=()=>{}}){this.key=key;this.token=token;this.fetch=fetchImpl;this.base=base;this.sleep=sleep;this.log=log;this.active=0;this.waiters=[];}
  async slot(fn){
    if(this.active<4)this.active++;else await new Promise(resolve=>this.waiters.push(resolve));
    try{return await fn();}finally{const next=this.waiters.shift();if(next)next();else this.active--;}
  }
  async request(relative,{signal}={}){
    return this.slot(async()=>{
    const url=new URL(this.base+relative);url.searchParams.set('key',this.key);url.searchParams.set('token',this.token);
    const label=relative.split('?')[0];
    const r=await this.fetchWithBackoff(url,{signal},label);
    if(!r.ok)throw new Error(`Trello returned HTTP ${r.status} for ${label}`);
    return r.json();
    });
  }
  async fetchWithBackoff(url,options,label){
    for(let attempt=0;attempt<5;attempt++){
      options.signal?.throwIfAborted();this.log(label);
      const response=await this.fetch(url,options);
      if((response.status!==429&&response.status<500)||attempt===4)return response;
      const retry=response.headers.get('retry-after');
      const delay=retry===null?NaN:/^\d+(?:\.\d+)?$/.test(retry.trim())?Number(retry)*1000:Date.parse(retry)-Date.now();
      await response.body?.cancel();options.signal?.throwIfAborted();
      // Retry-After is an authority deadline, including zero; otherwise back off.
      const ms=Number.isFinite(delay)?Math.max(0,delay):500*2**attempt;
      await abortable(options.signal?this.sleep(ms,options.signal):this.sleep(ms),options.signal);
    }
  }
  async boards(){return this.request('/members/me/boards?fields=name,shortLink,closed&filter=open');}
  async preview(boardId,{includeArchived=false,signal,maxFileMb=25,includeComments=true}={}){
    const filter=includeArchived?'all':'open',id=encodeURIComponent(boardId);
    const [board,lists]=await Promise.all([this.request(`/boards/${id}?fields=name,shortLink`,{signal}),this.request(`/boards/${id}/lists?filter=${filter}`,{signal})]);
    const cards=(await parallel(lists,4,l=>this.request(`/lists/${encodeURIComponent(l.id)}/cards?filter=${filter}&fields=id,idList,name,closed,badges&attachments=true&attachment_fields=all`,{signal}))).flat();
    const counts=mapBoard({...board,lists,cards},{includeArchived,maxFileMb}).counts;
    // Badges identify empty cards, but positive counts can include comments
    // no longer returned by Trello. Count the available comments for the preview.
    if(includeComments){const comments=await parallel(cards,4,async card=>card.badges?.comments===0?0:(await this.request(`/cards/${encodeURIComponent(card.id)}/actions?filter=commentCard&limit=1000`,{signal})).length);counts.comments=comments.reduce((sum,n)=>sum+n,0);}
    return {board,counts};
  }
  async board(boardId,{includeArchived=false,signal}={}){
    const filter=includeArchived?'all':'open',id=encodeURIComponent(boardId);
    const [board,lists,customFields]=await Promise.all([this.request(`/boards/${id}?fields=name,shortLink`,{signal}),this.request(`/boards/${id}/lists?filter=${filter}`,{signal}),this.request(`/boards/${id}/customFields`,{signal})]);
    const cardGroups=await parallel(lists,4,l=>this.request(`/lists/${encodeURIComponent(l.id)}/cards?filter=${filter}&fields=all&attachments=true&attachment_fields=all&checklists=all&customFieldItems=true&members=true&labels=all`,{signal}));
    const cards=cardGroups.flat();const actions=(await parallel(cards,4,c=>this.request(`/cards/${encodeURIComponent(c.id)}/actions?filter=commentCard&limit=1000`,{signal}))).flat();
    return {...board,lists,cards,actions,customFields};
  }
  async download(url,{signal,maxBytes}={}){
    return this.slot(async()=>{
    if(!trelloHosted(url))throw new Error('Only Trello-hosted attachments are downloaded');
    const auth=`OAuth oauth_consumer_key="${this.key}", oauth_token="${this.token}"`;
    let next=url;
    for(let n=0;n<5;n++){
      const headers=trelloHosted(next)?{Authorization:auth}:{};const r=await this.fetchWithBackoff(next,{headers,signal,redirect:'manual'},new URL(next).pathname);
      if(r.status>=300&&r.status<400&&r.headers.get('location')){await r.body?.cancel();next=new URL(r.headers.get('location'),next).href;if(new URL(next).protocol!=='https:')throw new Error('Invalid attachment redirect');continue;}
      if(!r.ok)throw new Error(`Attachment download returned HTTP ${r.status}`);
      if(Number(r.headers.get('content-length'))>maxBytes){await r.body?.cancel();throw Object.assign(new Error('Attachment exceeds file limit'),{oversize:true});}
      const chunks=[];let size=0;for await(const chunk of r.body){size+=chunk.length;if(size>maxBytes){await r.body.cancel?.().catch(()=>{});throw Object.assign(new Error('Attachment exceeds file limit'),{oversize:true});}chunks.push(Buffer.from(chunk));}return Buffer.concat(chunks);
    }throw new Error('Too many attachment redirects');
    });
  }
}
function abortable(promise,signal){
  if(!signal)return promise;
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(signal.reason??new Error('Import cancelled'));
    const clean=()=>signal.removeEventListener('abort',abort);
    Promise.resolve(promise).then(value=>{clean();resolve(value);},error=>{clean();reject(error);});
    if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
  });
}
export async function parallel(items,concurrency,fn){const result=new Array(items.length);let i=0;await Promise.all(Array.from({length:Math.min(concurrency,items.length)},async()=>{while(i<items.length){const at=i++;result[at]=await fn(items[at],at);}}));return result;}

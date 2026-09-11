import { trelloHosted } from './mapper.mjs';

export class TrelloClient {
  constructor({key,token,fetchImpl=fetch,base='https://api.trello.com/1',sleep=ms=>new Promise(r=>setTimeout(r,ms)),log=()=>{}}){this.key=key;this.token=token;this.fetch=fetchImpl;this.base=base;this.sleep=sleep;this.log=log;}
  async request(relative,{signal}={}){
    const url=new URL(this.base+relative);url.searchParams.set('key',this.key);url.searchParams.set('token',this.token);
    for(let n=0;n<5;n++){this.log(relative.split('?')[0]);const r=await this.fetch(url,{signal});if(r.ok)return r.json();if((r.status===429||r.status>=500)&&n<4){const retry=r.headers.get('retry-after');const ms=retry?(Number(retry)*1000||Math.max(0,Date.parse(retry)-Date.now())):500*2**n;await this.sleep(Math.min(120000,ms));continue;}throw new Error(`Trello returned HTTP ${r.status} for ${relative.split('?')[0]}`);}
  }
  async boards(){return this.request('/members/me/boards?fields=name,shortLink,closed&filter=open');}
  async board(boardId,{includeArchived=false,signal}={}){
    const filter=includeArchived?'all':'open',id=encodeURIComponent(boardId);
    const [board,lists,customFields]=await Promise.all([this.request(`/boards/${id}?fields=name,shortLink`,{signal}),this.request(`/boards/${id}/lists?filter=${filter}`,{signal}),this.request(`/boards/${id}/customFields`,{signal})]);
    const cardGroups=await parallel(lists,4,l=>this.request(`/lists/${encodeURIComponent(l.id)}/cards?filter=${filter}&fields=all&attachments=true&attachment_fields=all&checklists=all&customFieldItems=true&members=true&labels=all`,{signal}));
    const cards=cardGroups.flat();const actions=(await parallel(cards,4,c=>this.request(`/cards/${encodeURIComponent(c.id)}/actions?filter=commentCard&limit=1000`,{signal}))).flat();
    return {...board,lists,cards,actions,customFields};
  }
  async download(url,{signal,maxBytes}={}){
    if(!trelloHosted(url))throw new Error('Only Trello-hosted attachments are downloaded');
    const auth=`OAuth oauth_consumer_key="${this.key}", oauth_token="${this.token}"`;
    let next=url;
    for(let n=0;n<5;n++){
      const headers=trelloHosted(next)?{Authorization:auth}:{};const r=await this.fetch(next,{headers,signal,redirect:'manual'});
      if(r.status>=300&&r.status<400&&r.headers.get('location')){next=new URL(r.headers.get('location'),next).href;if(new URL(next).protocol!=='https:')throw new Error('Invalid attachment redirect');continue;}
      if(!r.ok)throw new Error(`Attachment download returned HTTP ${r.status}`);
      if(Number(r.headers.get('content-length'))>maxBytes)throw Object.assign(new Error('Attachment exceeds file limit'),{oversize:true});
      const chunks=[];let size=0;for await(const chunk of r.body){size+=chunk.length;if(size>maxBytes){await r.body.cancel?.().catch(()=>{});throw Object.assign(new Error('Attachment exceeds file limit'),{oversize:true});}chunks.push(Buffer.from(chunk));}return Buffer.concat(chunks);
    }throw new Error('Too many attachment redirects');
  }
}
export async function parallel(items,concurrency,fn){const result=new Array(items.length);let i=0;await Promise.all(Array.from({length:Math.min(concurrency,items.length)},async()=>{while(i<items.length){const at=i++;result[at]=await fn(items[at],at);}}));return result;}

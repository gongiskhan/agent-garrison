import fs from 'node:fs/promises';
import path from 'node:path';
export async function syncStatus(home){try{const value=JSON.parse(await fs.readFile(path.join(home,'obsidian-vault-sync-status.json'),'utf8'));return {lastSyncAt:value.ts??null,ok:['ok','nochange'].includes(value.state),message:value.message??'',state:value.state};}catch{return {lastSyncAt:null,ok:false,message:'never synced'};}}
export async function triggerSync(runNow){if(!runNow)throw Object.assign(new Error('Vault sync scheduler is unavailable'),{status:503});await runNow('vault-git-sync');return {started:true};}

'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, CheckCircle2, RefreshCw, AlertCircle, Plug } from 'lucide-react';
import type { Provider } from './types';
import { ProviderBadge } from './ProviderBadge';
import { request } from './client';
import styles from './providers.module.css';

function ProviderSettings({ provider, onNotice }: { provider: Provider; onNotice: (text: string) => void }) {
  const [days,setDays]=useState(provider.retentionDays??90);
  const [receipts,setReceipts]=useState(provider.sendReadReceipts??true);
  const [syncing,setSyncing]=useState(false);
  const timer=useRef<ReturnType<typeof setTimeout>>();
  const connected=!provider.setupHint && provider.health?.ok!==false;
  const status=provider.setupHint?'Needs setup':connected?'Connected':'Error';
  useEffect(()=>()=>clearTimeout(timer.current),[]);
  const save=async(body:Record<string,unknown>)=>{
    try { await request(`/providers/${encodeURIComponent(provider.id)}`,body); }
    catch(error) {onNotice(error instanceof Error?error.message:'Could not update provider settings');}
  };
  const retention=(value:number)=>{
    setDays(value);clearTimeout(timer.current);
    if(Number.isInteger(value)&&value>=1&&value<=3650)timer.current=setTimeout(()=>void save({retentionDays:value}),600);
  };
  const sync=async()=>{
    setSyncing(true);
    try {await request('/sync',{providers:[provider.id]});onNotice(`${provider.label} sync requested`);}
    catch(error){onNotice(error instanceof Error?error.message:'Could not sync provider');}
    finally{setSyncing(false);}
  };
  return <article className={styles.provider} aria-label={`${provider.label} settings`}>
    <div className={styles.providerTitle}><div><ProviderBadge provider={provider}/><h2>{provider.label}</h2></div><span className={`${styles.health} ${connected?styles.connected:styles.warning}`}>{connected?<CheckCircle2 size={15}/>:<AlertCircle size={15}/>} {status}</span></div>
    <ul className={styles.accounts}>{provider.accounts.map(account=>{
      const reason=account.setupHint||provider.accountHealth?.[account.id]?.reason;
      return <li key={account.id}><strong>{account.label}</strong>{account.address&&<span>{account.address}</span>}{reason&&<span>{reason}</span>}</li>;
    })}</ul>
    {provider.setupHint&&<p className={styles.hint}>{provider.label} needs setup: {provider.setupHint}. <Link href="/connectors">Open Connectors</Link></p>}
    {!provider.setupHint&&provider.health?.ok===false&&<p className={styles.hint}>{provider.health.reason||'The provider is temporarily unavailable.'}</p>}
    <dl className={styles.details}><div><dt>Last sync</dt><dd>{provider.lastSync?new Date(provider.lastSync).toLocaleString('en-GB',{dateStyle:'medium',timeStyle:'short'}):'Not synced yet'}</dd></div><div><dt>Sync interval</dt><dd>{provider.sync.mode==='stream'?'Live stream':`${provider.sync.intervalSeconds??60} seconds`}</dd></div></dl>
    <div className={styles.settings}>
      <label className={styles.retention}>Retention days<input aria-label={`${provider.label} retention days`} type="number" min="1" max="3650" inputMode="numeric" value={Number.isNaN(days)?'':days} onChange={event=>retention(event.target.valueAsNumber)}/></label>
      {typeof provider.sendReadReceipts==='boolean'&&<label className={styles.toggle}><span>Send read receipts</span><input aria-label={`${provider.label} send read receipts`} type="checkbox" role="switch" checked={receipts} onChange={event=>{const value=event.target.checked;setReceipts(value);void save({sendReadReceipts:value});}}/></label>}
    </div>
    {provider.kind!=='system'&&<button className={styles.sync} onClick={()=>void sync()} disabled={syncing||!connected}><RefreshCw size={17} className={syncing?styles.spinning:undefined}/>{syncing?'Syncing':'Sync now'}</button>}
  </article>;
}

export function ProvidersPage() {
  const [providers,setProviders]=useState<Provider[]>([]),[error,setError]=useState(''),[notice,setNotice]=useState(''),[loading,setLoading]=useState(true);
  const refresh=useCallback(async()=>{try{const data=await request<{providers:Provider[]}>('/providers');setProviders(data.providers);setError('');}catch(error){setError(error instanceof Error?error.message:'Could not load providers');}finally{setLoading(false);}},[]);
  useEffect(()=>{void refresh();const events=new EventSource('/api/messages/events');events.addEventListener('providers.changed',()=>void refresh());return()=>events.close();},[refresh]);
  return <div className={styles.page}>
    <header className={styles.header}><Link href="/messages" aria-label="Back to Messages"><ArrowLeft size={22}/></Link><div><p>Messages</p><h1>Providers</h1></div><Plug size={23}/></header>
    <div className={styles.content}>
      <p className={styles.intro}>Your connected accounts feed the same inbox. Set up accounts in <Link href="/connectors">Connectors</Link>.</p>
      {error&&<p role="alert" className={styles.hint}>{error}</p>}
      {loading&&<p role="status">Loading providers</p>}
      {!loading&&!providers.length&&!error&&<p>No providers yet. Connect an account in Connectors.</p>}
      <div className={styles.grid}>{providers.map(provider=><ProviderSettings key={provider.id} provider={provider} onNotice={setNotice}/>)}</div>
    </div>
    {notice&&<button role="status" className={styles.notice} onClick={()=>setNotice('')}>{notice}</button>}
  </div>;
}

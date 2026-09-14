import {useEffect, useMemo, useRef, useState} from 'react';
import Link from 'next/link';
import {useSearchParams} from 'next/navigation';
import {ChevronLeft, ChevronRight, Copy, File, Folder, FolderPlus} from 'lucide-react';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import bash from 'highlight.js/lib/languages/bash';
import {projectsUrl, workspaceUrl} from '../src/urls.mjs';
import {ApiError, Banner, Sheet, Skeleton, request, sizeLabel, type Bridge, type ProjectRef} from './common';

for (const [name, language] of Object.entries({javascript, typescript, json, python, css, xml, yaml, bash})) hljs.registerLanguage(name, language);
const languages: Record<string, string> = {js: 'javascript', jsx: 'javascript', mjs: 'javascript', ts: 'typescript', tsx: 'typescript', json: 'json', py: 'python', css: 'css', html: 'xml', xml: 'xml', yml: 'yaml', yaml: 'yaml', sh: 'bash'};
type Entry = {name: string; path: string; type: 'dir' | 'file'; size: number};
type Tree = {path: string; source: string; writable: boolean; items: Entry[]};
type FileBody = {path: string; kind: 'markdown' | 'text' | 'image'; encoding: 'utf8' | 'base64'; content: string; ext?: string; readOnly: boolean};
const parentPath = (value: string) => value.split('/').slice(0, -1).join('/');
const fileName = (value: string) => value.split('/').pop() || value;
const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function Code({file}: {file: FileBody}) {
  const language = languages[file.path.split('.').pop()?.toLowerCase() || ''];
  const html = useMemo(() => language ? hljs.highlight(file.content, {language, ignoreIllegals: true}).value : escape(file.content), [file.content, language]);
  return <div className="projects-code-scroll"><pre className="projects-code"><span className="projects-line-numbers" aria-hidden="true">{file.content.split('\n').map((_, index) => <span key={index}>{index + 1}</span>)}</span><code dangerouslySetInnerHTML={{__html: html}}/></pre></div>;
}

export function Files({reference, writable, title, base, bridge, dirtyPaths = []}: {reference: ProjectRef; writable: boolean; title: string; base: string; bridge: Bridge; dirtyPaths?: string[]}) {
  const path = useSearchParams().get('path') || '';
  const [tree, setTree] = useState<Tree | null>(null), [file, setFile] = useState<FileBody | null>(null);
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [revision, refresh] = useState(0);
  const [filter, setFilter] = useState(''), [toast, setToast] = useState('');
  const [newFolder, showNewFolder] = useState(false), [folderName, setFolderName] = useState('');
  const [editing, setEditing] = useState(false), [content, setContent] = useState(''), [working, setWorking] = useState(false), [editError, setEditError] = useState('');
  const currentCrumb = useRef<HTMLAnchorElement>(null);
  const api = (action: string) => reference.project === 'workspace' ? workspaceUrl(reference.node, action) : projectsUrl(reference, action);
  const treeUrl = api(`tree?path=${encodeURIComponent(path)}`), fileUrl = api(`file?path=${encodeURIComponent(path)}`);
  const parentUrl = api(`tree?path=${encodeURIComponent(parentPath(path))}`);
  const location = (rel: string) => `${base}${rel ? `?path=${encodeURIComponent(rel)}` : ''}`;
  useEffect(() => {
    const controller = new AbortController(), options = {signal: controller.signal};
    setLoading(true); setError(''); setTree(null); setFile(null); setEditing(false); setFilter(''); setEditError('');
    void (async () => {
      try {
        try {setTree(await request<Tree>(treeUrl, options));}
        catch (failure) {
          if (!(failure instanceof ApiError) || ![400, 404].includes(failure.status) || !path) throw failure;
          const [body, parent] = await Promise.all([request<FileBody>(fileUrl, options), request<Tree>(parentUrl, options)]);
          if (!controller.signal.aborted) {setFile(body); setTree(parent);}
        }
      } catch (failure) {
        if (controller.signal.aborted) return;
        setError(failure instanceof ApiError && failure.status === 413 ? `This file is too large to open here (${sizeLabel(failure.body.size || 0)}).`
          : failure instanceof ApiError && failure.status === 404 && path ? 'This file is no longer here.' : (failure as Error).message);
      } finally {if (!controller.signal.aborted) setLoading(false);}
    })();
    return () => controller.abort();
  }, [treeUrl, fileUrl, parentUrl, path, revision]);
  useEffect(() => {currentCrumb.current?.scrollIntoView({block: 'nearest', inline: 'end'});}, [tree?.path]);
  useEffect(() => {if (!toast) return; const timer = setTimeout(() => setToast(''), 2500); return () => clearTimeout(timer);}, [toast]);
  const items = tree?.items.filter(entry => entry.name.toLowerCase().includes(filter.toLowerCase())) || [];
  const folder = tree?.path || '', crumbs = folder.split('/').filter(Boolean);
  const size = file ? tree?.items.find(entry => entry.path === file.path)?.size ?? new TextEncoder().encode(file.content).length : 0;
  async function save() {
    setWorking(true); setEditError('');
    try {
      await request(api('file'), {method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify({path: file!.path, content, encoding: 'utf8'})});
      setFile(await request<FileBody>(fileUrl)); setEditing(false); setToast('Saved');
    } catch (failure) {setEditError((failure as Error).message);} finally {setWorking(false);}
  }
  async function createFolder(event: React.FormEvent) {
    event.preventDefault(); setWorking(true); setEditError('');
    try {
      await request(api('mkdir'), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({path: [folder, folderName].filter(Boolean).join('/')})});
      showNewFolder(false); setFolderName(''); refresh(value => value + 1);
    } catch (failure) {setEditError((failure as Error).message);} finally {setWorking(false);}
  }
  return <div className={`projects-files${file ? ' projects-file-open' : ''}`}>
    {toast && <div className="projects-toast" role="status">{toast}</div>}
    <nav className="projects-breadcrumb" aria-label="Folder breadcrumb"><Link href={base}>{title}</Link>{crumbs.map((crumb, index) => <span key={index}><ChevronRight size={15}/><Link ref={index === crumbs.length - 1 ? currentCrumb : undefined} aria-current={index === crumbs.length - 1 ? 'location' : undefined} href={location(crumbs.slice(0, index + 1).join('/'))}>{crumb}</Link></span>)}</nav>
    {error && <Banner retry={() => refresh(value => value + 1)}>{error}</Banner>}
    {loading ? <Skeleton/> : <div className="projects-file-layout"><section className="projects-folder-list" aria-label="Folder contents"><div className="projects-folder-tools"><label className="projects-filter"><span className="visually-hidden">Filter this folder</span><input type="search" placeholder="Filter this folder" value={filter} onChange={event => setFilter(event.target.value)}/></label>{writable && <button type="button" onClick={() => {setEditError(''); showNewFolder(true);}}><FolderPlus size={18}/>New folder</button>}</div>
      {folder && <Link className="projects-file-row" href={location(parentPath(folder))}><Folder size={20}/><span>..</span></Link>}
      {items.map(entry => <Link key={entry.path} className="projects-file-row" aria-current={entry.path === file?.path ? 'page' : undefined} href={location(entry.path)}>{entry.type === 'dir' ? <Folder size={20}/> : <File size={20}/>}<span>{entry.name}</span>{entry.type === 'file' ? <small>{sizeLabel(entry.size)}</small> : <ChevronRight size={18}/>}</Link>)}
      {tree && !tree.items.length && <p className="projects-empty">This folder is empty.</p>}
    </section>
      {file && <article className="projects-viewer" aria-label="File viewer"><Link className="projects-file-back" href={location(folder)}><ChevronLeft size={18}/>Back to folder</Link><header><div><h2>{fileName(file.path)}</h2><small>{sizeLabel(size)}</small></div><div className="projects-viewer-actions"><button type="button" onClick={() => void navigator.clipboard.writeText(file.path).then(() => setToast('Path copied')).catch(() => setToast('Could not copy path'))}><Copy size={17}/>Copy path</button>{dirtyPaths.includes(file.path) && <Link className="projects-button" href={`/projects/${encodeURIComponent(reference.node)}/${encodeURIComponent(reference.project)}/git?diff=${encodeURIComponent(file.path)}`}>Show diff</Link>}{writable && !file.readOnly && file.kind !== 'image' && !editing && <button type="button" onClick={() => {setContent(file.content); setEditing(true);}}>Edit</button>}</div></header>
        {editing ? <div className="projects-workspace-editor"><label><span className="visually-hidden">File content</span><textarea aria-label="File content" value={content} onChange={event => setContent(event.target.value)} spellCheck={false}/></label>{editError && <Banner>{editError}</Banner>}<div className="projects-sheet-actions"><button type="button" disabled={working} onClick={() => setEditing(false)}>Cancel</button><button type="button" disabled={working} onClick={() => void save()}>Save</button></div></div>
          : file.kind === 'markdown' ? <div className="markdown-body projects-markdown" dangerouslySetInnerHTML={{__html: bridge.render(file.content)}}/>
            : file.kind === 'image' ? <figure><img src={`data:image/${file.ext === 'svg' ? 'svg+xml' : file.ext === 'jpg' ? 'jpeg' : file.ext};base64,${file.content}`} alt={fileName(file.path)}/><figcaption>{fileName(file.path)}</figcaption></figure>
              : <Code file={file}/>}
      </article>}
    </div>}
    {newFolder && <Sheet title="New folder" close={() => {if (!working) showNewFolder(false);}}><form onSubmit={event => void createFolder(event)}><label>Folder name<input autoFocus value={folderName} onChange={event => setFolderName(event.target.value)}/></label>{editError && <Banner>{editError}</Banner>}<div className="projects-sheet-actions"><button type="button" disabled={working} onClick={() => showNewFolder(false)}>Cancel</button><button type="submit" disabled={working || !folderName.trim()}>Create</button></div></form></Sheet>}
  </div>;
}

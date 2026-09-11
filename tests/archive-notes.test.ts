import { it,expect } from 'vitest';import { scratch } from './archive-test-helpers';
// @ts-ignore
import { assertFolderRename } from '../packages/archive/src/notes.mjs';
it('locks note edits and returns the current content on a conflict',async()=>{const s=await scratch({seed:false});try{
 const name='Memory/Test.md';expect((await s.request('note','PUT',{path:name,markdown:'# First',baseSha:'new'})).status).toBe(200);const a=(await s.request('note?path='+name)).data;
 await s.write(name,'# Elsewhere');const conflict=await s.request('note','PUT',{path:name,markdown:'# Mine',baseSha:a.sha});expect(conflict.status).toBe(409);expect(conflict.data.current.markdown).toBe('# Elsewhere');expect((await s.request('note','PUT',{path:name,markdown:'# Mine',baseSha:conflict.data.current.sha})).status).toBe(200);
 expect(await s.read(name)).toBe('# Mine');
}finally{await s.close();}});
it('keeps mirrors and sidecars read-only and protects memory folder names',async()=>{const s=await scratch({seed:false});try{
 await s.write('Projects/Garrison/Memory/Claude Native/Mirror.md','# Generated');const name='Projects/Garrison/Memory/Claude Native/Mirror.md';const note=(await s.request('note?path='+name)).data;expect(note.readOnly).toBe(true);expect(note.provenance).toBe('mirror');expect((await s.request('note','PUT',{path:name,markdown:'# Changed',baseSha:note.sha})).status).toBe(403);expect(()=>assertFolderRename('Projects/Garrison/Memory/Child')).toThrow('Memory folders keep their names so agent links keep working.');
 await s.write('Archive/Inbox/x.txt.md','---\ngarrison: derived\n---\nText');const side=(await s.request('note?path=Archive/Inbox/x.txt.md')).data;expect((await s.request('note','PUT',{path:'Archive/Inbox/x.txt.md',markdown:'# Remove marker',baseSha:side.sha})).status).toBe(403);
}finally{await s.close();}});

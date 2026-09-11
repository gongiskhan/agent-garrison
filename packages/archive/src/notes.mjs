import path from 'node:path';
import { confine, fail, isMirror, areaOf } from './paths.mjs';
import { parseFrontmatter } from './frontmatter.mjs';
import { maybeRead, sha, lockedWrite } from './io.mjs';

export function assertNoteEditable(relative, parsed) {
  if(isMirror(relative))throw fail('Generated mirror. Edit the source note instead.',403);
  if(parsed?.frontmatter?.garrison==='derived')throw fail('Derived files are regenerated, not edited.',403);
  if(areaOf(relative)==='yours'&&['index.md','_list.md'].includes(path.posix.basename(relative)))throw fail('Use the card or list controls.',400);
  if(!relative.endsWith('.md'))throw fail('A note must be Markdown',400);
}
export function assertFolderRename(relative) {
  if(relative==='Projects/Garrison/Memory'||relative.startsWith('Projects/Garrison/Memory/'))throw fail('Memory folders keep their names so agent links keep working.',403);
  if(isMirror(relative))throw fail('Generated mirror. Edit the source note instead.',403);
}
export async function readNote(ctx,relative) {
  const raw=await maybeRead(confine(ctx.vaultDir,relative));if(raw===null)throw fail('Note not found',404);
  const parsed=parseFrontmatter(raw,path.basename(relative,'.md'));
  return {path:relative,frontmatter:parsed.frontmatter,markdown:raw,html:ctx.render(parsed.body),sha:sha(raw),readOnly:isMirror(relative)||parsed.frontmatter.garrison==='derived',provenance:isMirror(relative)?'mirror':areaOf(relative)==='yours'?'you':'garrison',parseWarning:parsed.parseWarning};
}
export async function writeNote(ctx,{path:relative,markdown,baseSha}) {
  assertNoteEditable(relative,parseFrontmatter(markdown));const file=confine(ctx.vaultDir,relative);const before=await maybeRead(file);
  if(before!==null)assertNoteEditable(relative,parseFrontmatter(before));
  return {sha:await lockedWrite(ctx,file,markdown,baseSha)};
}

import { describe,it,expect } from 'vitest';
// @ts-ignore
import { parseCard,serializeCard } from '../packages/archive/src/card.mjs';
describe('Archive card sections',()=>{
 it('normalises reserved sections and preserves unknown description headings',()=>{
  const parsed=parseCard('---\ngarrison: card\ntitle: Test\nextra: 7\n---\nDescription\n\n## Comments\n### 2026-09-11 10:14 · Gonçalo\nFirst\ncontinued\n\n## Links\n- [Portal](https://example.org/)\n\n## Unusual\nKeep this verbatim.\n\n## Checklists\n### Renewal\n- [ ] Book\n- [x] Photos\n\n## Details\n- Reference: TEST-1\n');
  expect(parsed.description).toContain('## Unusual\nKeep this verbatim.');expect(parsed.details).toEqual([{label:'Reference',value:'TEST-1'}]);expect(parsed.comments[0]).toMatchObject({author:'Gonçalo',markdown:'First\ncontinued'});expect(parsed.links[0].url).toBe('https://example.org/');
  parsed.checklists[0].items[0].done=true;const out=serializeCard(parsed);expect(out.match(/^## (Details|Links|Checklists|Comments)$/gm)).toEqual(['## Details','## Links','## Checklists','## Comments']);expect(parseCard(out).checklists[0].items.every((i:any)=>i.done)).toBe(true);expect(parseCard(out).frontmatter.extra).toBe(7);
 });
});

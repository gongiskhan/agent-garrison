import { describe,it,expect } from 'vitest';
// @ts-ignore
import { parseFrontmatter,stringifyFrontmatter } from '../packages/archive/src/frontmatter.mjs';
// @ts-ignore
import { parseCard } from '../packages/archive/src/card.mjs';
describe('Archive frontmatter',()=>{
 it('preserves unknown keys, order, nested values and YAML comments',()=>{
  const input='---\ncustom: {nested: [one, two]} # keep\ngarrison: card\ntitle: Cartão\nother: true\n---\nBody\n';const parsed=parseFrontmatter(input);
  parsed.frontmatter.title='Novo';const output=stringifyFrontmatter(parsed.frontmatter,parsed.body,parsed);const again=parseFrontmatter(output);
  expect(Object.keys(again.frontmatter)).toEqual(['custom','garrison','title','other']);expect(again.frontmatter.custom).toEqual({nested:['one','two']});expect(output).toContain('# keep');expect(again.body).toBe('Body\n');
 });
 it.each(['---\ntitle: [bad\n---\nBody','---\nnot closed','---\n- not a mapping\n---\nBody'])('tolerates malformed frontmatter: %s',raw=>{const card=parseCard(raw,'Folder fallback');expect(card.frontmatter.title).toBe('Folder fallback');expect(card.parseWarning).toBeTruthy();});
});

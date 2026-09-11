import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';

const root = path.join(process.cwd(), 'tests/fixtures/archive');
function walk(dir: string): string[] { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir,e.name)) : [path.join(dir,e.name)]); }
describe('Archive synthetic fixtures', () => {
  it('contains seven cards, five memory notes, an inbox image and valid derived hashes', () => {
    const files=walk(path.join(root,'vault'));
    expect(files.filter(p=>p.endsWith('/index.md'))).toHaveLength(7);
    expect(files.filter(p=>p.endsWith('.md')&&!p.includes('/Archive/'))).toHaveLength(5);
    expect(fs.existsSync(path.join(root,'vault/Archive/Inbox/sample-document.jpg'))).toBe(true);
    for(const p of files.filter(p=>p.endsWith('.jpg.md')||p.endsWith('.pdf.md'))) {
      const meta=parse(fs.readFileSync(p,'utf8').split('---')[1]);
      expect(meta.sha256).toBe(createHash('sha256').update(fs.readFileSync(p.slice(0,-3))).digest('hex'));
      expect(meta.garrison).toBe('derived');
    }
  });
  it('provides a complete nine-card Trello board including archived and special cases', () => {
    const board=JSON.parse(fs.readFileSync(path.join(root,'trello-board.json'),'utf8'));
    expect(board.lists).toHaveLength(3); expect(board.cards).toHaveLength(9);
    expect(board.cards.filter((c:any)=>c.closed)).toHaveLength(1);
    expect(board.cards.some((c:any)=>c.name.includes('/'))).toBe(true);
    expect(board.cards[0].customFieldItems[0].value.text).toBe('FAKE-2026');
    expect(board.actions).toHaveLength(11);
  });
  it('ships three generated images and text-layer plus three-page scanned PDFs', () => {
    for(const name of ['sample-document','sample-house','sample-receipt']) {
      expect(fs.readFileSync(path.join(root,name+'.svg'),'utf8')).toContain('SYNTHETIC SAMPLE - NOT VALID');
      expect(fs.readFileSync(path.join(root,name+'.jpg')).subarray(0,2).toString('hex')).toBe('ffd8');
    }
    expect(fs.readFileSync(path.join(root,'sample-text.pdf'),'latin1')).toContain('TEST-48392017');
    const scanned=fs.readFileSync(path.join(root,'sample-scanned.pdf'),'latin1');
    expect(scanned).toContain('/Count 3'); expect(scanned).toContain('/Subtype /Image');
    expect(scanned).not.toContain('TEST-48392017');
  });
});

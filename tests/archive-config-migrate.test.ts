import { it,expect } from 'vitest';import { migrateArchiveManifest,migrateArchiveYaml,ARCHIVE_DEFAULTS } from '../src/lib/composition-migrate';
it('adds schema-4 Archive defaults once and preserves existing choices',()=>{const manifest:any={'x-garrison':{composition:{schema:4,global_config:{other:17}}}};expect(migrateArchiveManifest(manifest)).toBe(true);expect(manifest['x-garrison'].composition.global_config).toEqual({other:17,archive:ARCHIVE_DEFAULTS});manifest['x-garrison'].composition.global_config.archive.author='Another author';expect(migrateArchiveManifest(manifest)).toBe(false);expect(manifest['x-garrison'].composition.global_config.archive.author).toBe('Another author');expect(migrateArchiveManifest({'x-garrison':{composition:{schema:3}}})).toBe(false);});

it('adds defaults without dropping comments or reflowing unrelated duties',()=>{
 const raw='x-garrison:\n  composition:\n    schema: 4\n    global_config:\n      # Keep authored context.\n      name: Test\n    duties:\n      - description: >-\n          Keep this exact\n          line wrapping.\n';
 const next=migrateArchiveYaml(raw);
 expect(next.replace(/      archive:\n(?:        [^\n]*\n)+/, '')).toBe(raw);
 expect(next).toContain('extract_target: cc-sonnet');
 expect(migrateArchiveYaml(next)).toBe(next);
});

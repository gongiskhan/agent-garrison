import {describe, expect, it} from 'vitest';
import {diffLines} from '../packages/projects/ui/diff';

describe('unified diff line numbers', () => {
  it('counts the old and new sides independently, without counting file headers or newline notices', () => {
    const rows = diffLines('diff --git a/example.txt b/example.txt\n--- a/example.txt\n+++ b/example.txt\n@@ -4,2 +4,3 @@\n-before\n+after\n+another\n shared\n\\ No newline at end of file\n');
    expect(rows.slice(0, 3).map(row => row.kind)).toEqual(['meta', 'meta', 'meta']);
    expect(rows.slice(4).map(row => [row.kind, row.old, row.next])).toEqual([
      ['removed', 4, null], ['added', null, 4], ['added', null, 5], ['context', 5, 6], ['meta', null, null]
    ]);
  });
  it('resets the counters at every hunk and treats the next file header as metadata', () => {
    const rows = diffLines('@@ -1 +1 @@\n-first\n+second\ndiff --git a/other.txt b/other.txt\n--- a/other.txt\n+++ b/other.txt\n@@ -9 +12 @@\n-old\n+new\n');
    expect(rows[5].kind).toBe('meta');
    expect(rows.at(-2)).toMatchObject({kind: 'removed', old: 9, next: null});
    expect(rows.at(-1)).toMatchObject({kind: 'added', old: null, next: 12});
  });
});

import type { Filter, Rule } from './types';
export function ftsPrefix(text: string): string;
export function filterToSql(filter?: Filter | Rule['match'], options?: { defaults?: boolean }): { sql: string; params: unknown[] };

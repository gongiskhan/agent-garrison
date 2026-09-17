import {execFile} from 'node:child_process';
import path from 'node:path';
import {promisify} from 'node:util';
import {expect, it} from 'vitest';

it('keeps existing tablet coverage while collecting Projects on phone and desktop', async () => {
  const {stdout} = await promisify(execFile)(process.execPath, [path.resolve('node_modules/@playwright/test/cli.js'), 'test', '--list'], {
    cwd: process.cwd(), timeout: 30_000, maxBuffer: 1024 * 1024
  });
  const rows = stdout.split('\n').filter(line => /^\s+\[(desktop-chromium|tablet|mobile)\]/.test(line));
  const collected = (project: string) => rows.filter(line => line.includes(`[${project}]`));
  const projects = (project: string) => collected(project).filter(line => /› projects[/\\]/.test(line));
  expect(collected('tablet').length).toBeGreaterThan(0);
  expect(projects('tablet')).toEqual([]);
  expect(projects('mobile').length).toBeGreaterThan(0);
  expect(projects('desktop-chromium').length).toBe(projects('mobile').length);
}, 35_000);

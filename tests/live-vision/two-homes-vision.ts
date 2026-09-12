import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { expect, type TestInfo } from '@playwright/test';

/** Like kanban-loop-v1d: the working agent must inspect each actual screenshot.
 * A verdict is tied to its bytes and rubric, so DOM checks cannot approve it. */
export async function judgeScreenshot(file: string, rubric: string, info: TestInfo) {
  const imageSha = createHash('sha256').update(await fs.readFile(file)).digest('hex');
  const requestFile = file.replace(/\.png$/, '.vision-request.json');
  const verdictFile = file.replace(/\.png$/, '.vision.json');
  await fs.writeFile(requestFile, JSON.stringify({ file, imageSha, rubric }, null, 2) + '\n');
  console.log(`Screenshot awaiting visual inspection: ${requestFile}`);
  let judgment: { imageSha: string; rubric: string; pass: boolean; reasons: string[] } | undefined;
  await expect.poll(async () => {
    try { const candidate = JSON.parse(await fs.readFile(verdictFile, 'utf8')); if (candidate.imageSha === imageSha && candidate.rubric === rubric) judgment = candidate; } catch { /* Inspection has not been recorded yet. */ }
    return !!judgment;
  }, { timeout: 240000, intervals: [500, 1000, 2000] }).toBe(true);
  await info.attach('vision-' + path.basename(file), { body: JSON.stringify(judgment), contentType: 'application/json' });
  expect(judgment!.pass, judgment!.reasons.join('\n')).toBe(true);
}

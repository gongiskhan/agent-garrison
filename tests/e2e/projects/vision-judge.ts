import fs from 'node:fs/promises';
import path from 'node:path';
import {expect, type TestInfo} from '@playwright/test';
import type {ProjectsApp} from './app-fixture';

export const rubrics: Record<string, string> = {
  picker: 'A list titled Projects grouped by node. Each group starts with a coloured node chip and name. The first row of each group is Garrison files. Project rows show a branch and change chips. Rows are tall enough to tap. Nothing is cut off and there is no horizontal scrollbar.',
  files: 'A breadcrumb, a filter field and a list with folders before files, sizes right aligned. A read-only banner is visible with a Git link.',
  viewer: 'A file name header with Copy path. Below it rendered markdown with a heading and a list, readable, not cut off.',
  git: 'A status strip with a branch chip and change chips, four action buttons in a column on a phone or a row on desktop, a Changes list with coloured two-letter badges, and a Commits list with short hashes.',
  diff: 'A unified diff with hunk headers, green added lines and red removed lines, line numbers in a gutter, scrolling inside its own box.',
  'commit-sheet': 'A sheet titled Commit and push with a prefilled message field and two buttons, Cancel and Commit and push, above the keyboard area.',
  'mesh-picker': 'Two node groups with different accent colours, one marked as this node, both listing projects.',
  'peer-git': "The project header shows the peer node chip, and the Git tab shows that peer's branch and changes."
};

export async function judge(app: ProjectsApp, file: string, name: string, info: TestInfo) {
  const rubric = rubrics[name]; if (!rubric) throw new Error(`Missing Projects rubric: ${name}`);
  const relative = `Screenshots/${path.basename(file)}`;
  await fs.mkdir(path.join(app.vault, 'Screenshots'), {recursive: true});
  await fs.copyFile(file, path.join(app.vault, relative));
  const prompt = `You are checking a screenshot of a mobile or desktop web page against a\nshort rubric. Return ONLY JSON: { "pass": true|false, "reasons": [ "..." ] }.\nFail when a rubric item is clearly absent, when text is cut off or overlaps,\nwhen the page has a horizontal scrollbar (scrolling inside a diff, code block or breadcrumb is allowed), or when interactive elements are too\nsmall to tap (visibly under about 44 px on a 390 px wide phone screenshot).\nDo not fail for colour or style preferences. Rubric:\n${rubric}`;
  const response = await fetch(app.base + '/api/archive/look', {method: 'POST', headers: {'content-type': 'application/json', 'x-garrison-internal': app.token}, body: JSON.stringify({imagePaths: [relative], prompt, schemaName: 'judge'}), signal: AbortSignal.timeout(150_000)});
  const result = await response.json(), fileName = info.outputPath(`vision-${name}-${info.project.name}.json`);
  await fs.writeFile(fileName, JSON.stringify({rubric, ...result}, null, 2) + '\n');
  await info.attach(`vision-${name}`, {path: fileName, contentType: 'application/json'});
  expect(response.ok, JSON.stringify(result)).toBe(true);
  expect(result.json.pass, (result.json.reasons || []).join('\n')).toBe(true);
}

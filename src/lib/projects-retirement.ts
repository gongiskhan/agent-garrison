import fs from 'node:fs/promises';
import path from 'node:path';
import {garrisonDir} from './claude-home';
import {CasMismatchError, writeFileAtomic} from './atomic-write';
import {RETIRED_PROJECTS_FITTING, retireProjectsYaml} from './composition-migrate';

export async function recordProjectsRetirement(composition: string, home = garrisonDir()) {
  const directory = path.join(home, 'migrations', 'projects');
  await fs.mkdir(directory, {recursive: true});
  const file = path.join(directory, `${encodeURIComponent(composition)}.json`);
  const record = {at: new Date().toISOString(), composition, removed: [RETIRED_PROJECTS_FITTING]};
  try {await writeFileAtomic(file, JSON.stringify(record, null, 2) + '\n', {mode: 0o600, cas: {priorContent: null}});}
  catch (error) {if (!(error instanceof CasMismatchError)) throw error;}
}

/** First-load cleanup is idempotent and cannot overwrite a concurrent edit. */
export async function retireProjectsFile(file: string, composition: string, home = garrisonDir()) {
  for (let attempt = 0; attempt < 4; attempt++) {
    let before: string;
    try {before = await fs.readFile(file, 'utf8');}
    catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error;}
    const after = retireProjectsYaml(before);
    if (after === before) return;
    try {await writeFileAtomic(file, after, {cas: {priorContent: before}});}
    catch (error) {if (error instanceof CasMismatchError && attempt < 3) continue; throw error;}
    await recordProjectsRetirement(composition, home);
    return;
  }
}

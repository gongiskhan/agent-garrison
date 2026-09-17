import {PROJECTS_LABEL} from '../label.mjs';

export const PROJECTS_CAPABILITIES = [
  `- core:projects - ${PROJECTS_LABEL}, files and git on every node`,
  '',
  '  The Garrison files view is the artifact surface. To hand the user a file, write it',
  '  with a plain filesystem write (mkdir -p the folder, write the file - no',
  '  API involved) under `~/.garrison/files/<namespace>/` (or',
  '  `$GARRISON_FILEBROWSER_ROOT` when set). Namespaces:',
  '',
  '  - `documents/` - user-facing markdown, reports, specs',
  '  - `recordings/` - audio, video, screen captures',
  '  - `runs/` - run outputs, logs, evidence from automated work',
  '  - `uploads/` - files the user supplied',
  '',
  '  Prefix filenames with the ISO date (`2026-07-10-feature-spec.md`) so',
  `  listings sort chronologically. The user views everything in ${PROJECTS_LABEL}, under Garrison files`,
  '  on phone or desktop: markdown renders, images display',
  '  inline, text files are editable.'
].join('\n');

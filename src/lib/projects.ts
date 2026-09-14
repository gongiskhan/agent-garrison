import {garrisonDir} from './claude-home';
import {readNodeIdentity} from './node-identity';
import {crossSiteBlocked} from './mesh/peer-auth';
import {projectsResolver} from './projects-resolver';
// @ts-ignore The core package is also exercised directly as ESM.
import {createProjectsService} from '../../packages/projects/src/projects.mjs';

export function projectsService() {
  return createProjectsService({
    ...projectsResolver(),
    env: {...process.env, GARRISON_HOME: garrisonDir()},
    guard: crossSiteBlocked,
    node: () => {
      const identity = readNodeIdentity();
      return {id: identity.id, name: identity.name, accentColor: identity.accentHex, isSelf: true, state: 'online'};
    }
  });
}

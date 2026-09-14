import {garrisonDir} from './claude-home';
import {readNodeIdentity} from './node-identity';
import {projectsResolver} from './projects-resolver';
import {stateClient, stateEnrolled} from './state-client';
// @ts-ignore The pump package is also exercised directly as ESM.
import {ensurePump} from '../../packages/projects/src/pump.mjs';

export function ensureProjectsPump() {
  if (process.env.GARRISON_PROJECTS_PUMP === '0' || !stateEnrolled()) return null;
  const identity = readNodeIdentity();
  return ensurePump({client: stateClient(), ...projectsResolver(), env: {...process.env, GARRISON_HOME: garrisonDir(), GARRISON_NODE_NAME: identity.id}, log: console.info});
}

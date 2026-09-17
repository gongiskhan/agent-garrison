import {describe,it,expect} from 'vitest';import {readFileSync} from 'node:fs';import path from 'node:path';import os from 'node:os';import YAML from 'yaml';
// @ts-ignore Public state client owns node credential discovery.
import {StateClient,discoverStateConfig} from '../packages/garrison-state-client/index.mjs';
// @ts-ignore ESM core
import {TrelloClient} from '../packages/archive/src/trello/client.mjs';
describe.skipIf(process.env.GARRISON_INTEGRATION!=='1')('Archive Trello live read-only',()=>{
 it('lists boards using only the connector’s declared scoped credentials',async()=>{
  // The test home/vault remain scratch. This explicit authority connection reads
  // sealed connector credentials through the same public contract as the shell.
  const config=discoverStateConfig({env:{GARRISON_HOME:process.env.ARCHIVE_AUTH_NODE_HOME??path.join(os.homedir(),'.garrison')},readFileSync});
  const scope=YAML.parse(readFileSync(path.join(process.cwd(),'fittings/seed/trello/apm.yml'),'utf8'))['x-garrison'].secret_scope;
  const {values}=await new StateClient(config).resolveSecrets(scope);expect(Boolean(values.TRELLO_KEY&&values.TRELLO_TOKEN),'Trello credentials must be sealed').toBe(true);
  const boards=await new TrelloClient({key:values.TRELLO_KEY,token:values.TRELLO_TOKEN}).boards();expect(Array.isArray(boards)).toBe(true);for(const board of boards){expect(typeof board.id).toBe('string');expect(typeof board.name).toBe('string');}
 },45000);
});

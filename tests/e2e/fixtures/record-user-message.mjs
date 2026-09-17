import {openConversation} from '../../../packages/claude-pty/src/conversation-store.mjs';
import {recordUserMessage} from '../../../fittings/seed/http-gateway/scripts/lib/stretch.mjs';

const store=openConversation('api-journey',{role:'gateway',env:{GARRISON_HOME:process.argv[2]}});
const input=JSON.parse(process.argv[3]);
process.stdout.write(JSON.stringify(recordUserMessage(store,{...input,text:input.message})));

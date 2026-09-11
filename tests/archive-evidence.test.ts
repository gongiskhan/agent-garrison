import {it,expect} from 'vitest';
import config from '../playwright.archive.config';
it('captures screenshots only at explicit privacy-checked checkpoints',()=>{
 expect(config.use?.screenshot).toBe('off');
 expect(config.use?.trace).toMatchObject({screenshots:false,snapshots:true});
 expect(config.use?.video).toBe(process.env.ARCHIVE_WALKTHROUGH==='1'?'on':'off');
});

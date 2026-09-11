import {it,expect,vi,beforeEach} from 'vitest';
const lookup=vi.hoisted(()=>vi.fn());
vi.mock('@/lib/archive-legacy',()=>({legacyDocumentRedirect:lookup}));
vi.mock('next/navigation',()=>({redirect:(url:string)=>{throw new Error('Redirect: '+url);}}));
vi.mock('@/components/fitting-views/FittingSurfacePanel',()=>({FittingSurfacePanel:()=>null}));
import Page from '../src/app/fitting/[fittingId]/[[...rest]]/page';
beforeEach(()=>lookup.mockReset());
it('redirects legacy read and edit deep links through the migrated document table',async()=>{
 lookup.mockResolvedValue('/archive/notes?path=Projects%2FGarrison%2FDocuments%2FFixture.md');
 for(const rest of [['legacy-id'],['legacy-id','edit']])await expect(Page({params:Promise.resolve({fittingId:'documents',rest})})).rejects.toThrow('Redirect: /archive/notes?path=Projects%2FGarrison%2FDocuments%2FFixture.md');
 expect(lookup).toHaveBeenCalledWith('legacy-id');
});
it('sends the retired fitting root or missing document to Archive without altering another fitting',async()=>{
 await expect(Page({params:Promise.resolve({fittingId:'documents'})})).rejects.toThrow('Redirect: /archive');expect(lookup).not.toHaveBeenCalled();
 lookup.mockResolvedValue('/archive');await expect(Page({params:Promise.resolve({fittingId:'documents',rest:['missing']})})).rejects.toThrow('Redirect: /archive');
});

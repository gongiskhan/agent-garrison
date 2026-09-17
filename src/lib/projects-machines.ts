// @ts-ignore Machine contracts are also tested directly as ESM.
import {createMachines} from '../../packages/projects/src/machines.mjs';

export function projectsMachines() {
  return createMachines({discover: async () => {
    const {GET} = await import('@/app/api/fittings/views/route');
    const response = await GET();
    if (!response.ok) return null;
    const {views} = await response.json();
    const shell = views?.find((view: {fittingId: string; healthy: boolean}) => view.fittingId === 'remote-shell-runtime' && view.healthy);
    return shell?.url || null;
  }});
}

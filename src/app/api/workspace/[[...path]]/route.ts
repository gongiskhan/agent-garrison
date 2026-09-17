import {projectsService} from '@/lib/projects';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = {params: {path?: string[]}};
function handle(request: Request, {params}: Context) {
  return projectsService().handle(request, params.path ?? [], 'workspace');
}
export const GET = handle;
export const PUT = handle;
export const POST = handle;

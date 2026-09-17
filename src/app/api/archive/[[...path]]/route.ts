import { archiveService } from '../_context';
export const runtime='nodejs';
export const dynamic='force-dynamic';
async function handle(request:Request,{params}:{params:{path?:string[]}}){
  try{return await(await archiveService()).handle(request,(params.path??[]).join('/'));}
  catch(error){return Response.json({error:error instanceof Error?error.message:String(error)},{status:500});}
}
export {handle as GET,handle as POST,handle as PUT,handle as PATCH,handle as DELETE};

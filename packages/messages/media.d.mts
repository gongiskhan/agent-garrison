import type { Attachment } from './types';
export function attachmentRelativePath(provider:string,account:string,id:string,mime:string,at?:Date):string;
export function confinedPath(root:string,relative:string,options?:{mustExist?:boolean}):Promise<string>;
export function saveBytes(root:string,relative:string,bytes:Uint8Array):Promise<string>;
export function normalizeAudio(root:string,relative:string,options?:{voice?:boolean;ffmpeg?:string;ffprobe?:string;run?:Function}):Promise<{path:string;durationMs:number;mime:string;ptt?:boolean}>;
export function thumbnail(root:string,relative:string,options?:{ffmpeg?:string;run?:Function}):Promise<string>;
export function transcribeAttachment(attachment:Attachment,transcribe:(attachment:Attachment,options:{model:string;language:string;detect_language:boolean})=>Promise<{transcript:string}>,options?:{onState?:(attachment:Attachment)=>Promise<void>}):Promise<Attachment>;

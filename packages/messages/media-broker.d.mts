import type {Attachment} from './types';
export function prepareMessageAttachments(root:string,attachments:Attachment[]):Promise<Attachment[]>;
export function transcriptionEnvironment(root:string):NodeJS.ProcessEnv;
export function transcriptionPermissions(bundle:string,root:string):string[];
export function createTranscriptionBroker(root:string,attachments:Attachment[],options?:{captureUrl?:string;captureToken?:string;fetchImpl?:typeof fetch}):(request:unknown)=>Promise<{transcript:string}>;

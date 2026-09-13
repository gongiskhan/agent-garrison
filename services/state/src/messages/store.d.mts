export function acquireIngestLease(db: unknown,node:string,options?:{at?:number}): {granted:boolean;holderNode:string;expiresAt:string;token?:string;fence?:number};
export function authenticateIngest(db:unknown,token:string|undefined,at?:number): {name:string;scope:string;fence:number;tokenHash:string}|null;

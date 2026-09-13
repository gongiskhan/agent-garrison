export function openDb(path?:string): {prepare(sql:string):any;transaction<T extends (...args:any[])=>any>(work:T):T;close():void};
export function binarySchemaVersion():number;
export function resolveDbPath():string;
export function listMigrations():string[];

declare module '*/scripts/messages-live-smoke.mjs' {
  export function selfTarget(provider: any, account: any): Record<string,string>;
  export function smokeOptions(args: string[]): {base:string;send:boolean;out:string;assets:string;providers:string[]};
  export function runSmoke(options: any, deps?: any): Promise<any>;
}

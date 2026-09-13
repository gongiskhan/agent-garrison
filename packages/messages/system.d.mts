export interface SystemDependencies { client?: { request: (...args: any[]) => Promise<any> }; env?: Record<string, string | undefined>; fetchImpl?: typeof fetch }
export function emitSystemMessage(input: Record<string, any>, deps?: SystemDependencies): Promise<any>;
export function systemEventKey(source: string, identity: unknown): string;
export function systemInputFromNotification(payload: Record<string, any>, source?: string): Record<string, any>;
export function isMessageMirror(payload: unknown): boolean;
export function deliverMessageMirrors(message: any, deps?: SystemDependencies & { targets?: { id: string; url: string }[]; deliveredTargets?: string[] }): Promise<any[]>;
export function cardEventSystemInput(card: any, event: any, options?: { ownerNode?: string | null }): Record<string, any>;

export function dispatchSystemAnswer(message: any, answer: string, deps?: { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; forwardMessage?: (input: any) => Promise<any>; revert?: (input: any) => Promise<any>; cancelSend?: (id: string) => Promise<any> }): Promise<any>;
export function messageCardPayload(message: any, options?: { project?: string; flow?: string }): Record<string, any>;
export function createCardFromMessage(message: any, options?: { project?: string; flow?: string }, deps?: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; createCard?: (input: any) => Promise<any> }): Promise<any>;
export function messageCardId(idempotencyKey: string): string;

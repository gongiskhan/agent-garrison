// Connector executors are plain JS (.mjs) Fitting scripts. Tests import their
// exported CATALOG + runAction; this ambient declaration gives them types so
// tsc --noEmit doesn't flag the JS import as implicit-any.
declare module "*/connector.mjs" {
  export const CATALOG: {
    service: string;
    auth: string;
    actions: Array<{ name: string; args?: string[]; mutates?: boolean; description?: string }>;
  };
  export function runAction(input: {
    action: string;
    args?: Record<string, unknown>;
    env?: Record<string, string | undefined>;
    fetchImpl?: (url: string, opts?: unknown) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;
  }): Promise<unknown>;
}

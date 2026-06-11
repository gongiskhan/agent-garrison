// Hand-written declarations for view-state.mjs (the repo compiles with
// allowJs: false; Garrison's vitest gate imports this helper directly).

export interface InstanceEnvelopeRead {
  exists: boolean;
  state?: unknown;
  updatedAt?: string;
}

export interface InstanceRecord {
  instanceId: string;
  state: unknown;
  updatedAt: string;
}

export function instanceDir(fittingId: string): string;
export function instanceFile(fittingId: string, instanceId: string): string;
export function writeInstanceState(
  fittingId: string,
  instanceId: string,
  state: unknown
): Promise<{ fittingId: string; instanceId: string; updatedAt: string; state: unknown }>;
export function readInstanceState(fittingId: string, instanceId: string): Promise<InstanceEnvelopeRead>;
export function readAllInstances(fittingId: string): Promise<InstanceRecord[]>;
export function deleteInstance(fittingId: string, instanceId: string): Promise<boolean>;
export function scheduleInstanceWrite(
  fittingId: string,
  instanceId: string,
  stateFactory: () => unknown | Promise<unknown>,
  delayMs?: number
): void;
export function cancelInstanceWrite(fittingId: string, instanceId: string): void;
export function flushInstanceWrites(): Promise<void>;

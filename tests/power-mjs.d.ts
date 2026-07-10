// Ambient types for the Power Fitting's plain-JS (.mjs) lib modules so the TS
// tests can import them under tsc --noEmit without implicit-any errors (allowJs
// is false). Mirrors tests/automations-mjs.d.ts.
declare module "*/power-default/lib/power-core.mjs" {
  export function parseIdleSeconds(input: unknown): number;
  export function isRemoteFrom(from: unknown): boolean;
  export function parseW(output: unknown): any[];
  export function sessionsSignal(stateJson: any, opts?: { now?: number }): any;
  export function kanbanSignal(cards: any[], board: any): any;
  export function presenceSignal(records: any[], opts?: { now?: number; idleMinutes?: number }): any;
  export function sshSignal(sessions: any[], opts?: { idleMinutes?: number }): any;
  export function loadSignal(load1: number, threshold: number): any;
  export function keepAwakeSignal(keepAwake: any, opts?: { now?: number }): any;
  export function aggregateSignals(signals: any[]): { busy: boolean; signals: any[] };
  export function tickCountdown(prev: any, opts: { busy: boolean; now: number; idleMinutes?: number }): any;
  export function awakeMillis(log: any[], windowStart: number, now: number): number;
  export function awakeHoursSummary(log: any[], opts: { now: number; dayStartMs?: number }): { today: number; last7d: number };
  export function startOfLocalDay(now: number): number;
}
declare module "*/power-default/lib/gcp-suspend.mjs" {
  export function suspendSelf(opts?: { fetchImpl?: any }): Promise<any>;
  export function suspendUrl(id: { project: string; zone: string; name: string }): string;
  export function resolveInstanceIdentity(fetchImpl: any): Promise<any>;
}

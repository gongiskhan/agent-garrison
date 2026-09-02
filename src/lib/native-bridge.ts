// The Garrison iOS app is a Capacitor webview pointed at a node. Capacitor
// injects `window.Capacitor` with the five native plugins the app registers
// (ios/GarrisonApp/Plugins). This module is the shell's ONLY reader of that
// global: feature-detected, typed, and null in a browser, so a page renders the
// same markup on the server, in Safari, and in the app, and reaches for native
// only after mount.
//
// The contract mirrors the Swift side field for field; a new method lands in
// both places or in neither. The capture token never crosses this boundary
// (`hasToken` is all the page learns - decision D35).

export type CaptureKind = "microphone" | "screen_audio";

export interface NodeInfo {
  name: string;
  shellOrigin: string;
  captureBaseURL: string;
  hasToken: boolean;
}

export interface AppInfo {
  appVersion: string;
  build: string;
  platform: string;
  bundleId: string;
}

export interface CaptureStatus {
  phase: "idle" | "connecting" | "live" | "interrupted" | "failed";
  error?: string;
  sessionId?: string;
  startedAt?: number;
  ackedFrames: number;
  broadcasting: boolean;
  broadcastError?: string;
  microphone: string;
  consentSuppressed: boolean;
}

export interface PushStatus {
  authorization: string;
  registered: boolean;
  detail: string;
}

// The GarrisonPendant payload, keyed exactly as GarrisonPendantPlugin.swift
// builds it (statusPayload). connectionState carries the PendantConnectionState
// case names: disconnected | scanning | connecting | connected | reconnecting |
// pairingLost | bluetoothOff. uploaderState is the capture session's state on
// the phone: idle | connecting | streaming | ended | failed.
export interface PendantStatus {
  connectionState: string;
  paired: boolean;
  lostFrames: number;
  ambientConsent: boolean;
  uploaderState?: string;
  uploaderError?: string;
  battery?: number;
  sessionId?: string;
  hapticSupported?: boolean;
  capturePolicy?: string;
  pendantFlagOn?: boolean;
  [key: string]: unknown;
}

export interface ListenerHandle {
  remove: () => Promise<void> | void;
}

// Capacitor's plugin proxy: every method is a promise-returning function, and
// `addListener` is one of them (it resolves to a handle). Typed loosely here
// and narrowed per call below.
interface CapPluginWithEvents {
  [method: string]: ((...args: unknown[]) => Promise<unknown>) | undefined;
}
interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  Plugins?: Record<string, CapPluginWithEvents | undefined>;
}

function capacitor(): CapacitorGlobal | null {
  if (typeof window === "undefined") return null;
  const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  return cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform() ? cap : null;
}

/** True only inside the Garrison iOS app. Safe to call during render on the
 *  client; always false on the server. */
export function isNativeApp(): boolean {
  return capacitor() !== null;
}

function plugin(name: string): CapPluginWithEvents {
  const cap = capacitor();
  const p = cap?.Plugins?.[name];
  if (!p) throw new Error(`native bridge: ${name} is not available here`);
  return p;
}

async function call<T>(name: string, method: string, args?: Record<string, unknown>): Promise<T> {
  const p = plugin(name);
  const fn = p[method];
  if (typeof fn !== "function") throw new Error(`native bridge: ${name}.${method} is not a method`);
  return (await fn(args ?? {})) as T;
}

async function listen(name: string, event: string, cb: (data: never) => void): Promise<ListenerHandle> {
  const p = plugin(name);
  const add = p.addListener;
  if (typeof add !== "function") throw new Error(`native bridge: ${name} has no events`);
  return (await add(event, cb)) as ListenerHandle;
}

export const nativeNode = {
  /** The node this webview is loaded from, or null before the first add. */
  current: async (): Promise<NodeInfo | null> => {
    const r = await call<Partial<NodeInfo>>("GarrisonNode", "current");
    return r && typeof r.name === "string" && r.name ? (r as NodeInfo) : null;
  },
  list: async (): Promise<NodeInfo[]> => (await call<{ nodes?: NodeInfo[] }>("GarrisonNode", "list")).nodes ?? [],
  add: (args: { shellOrigin: string; token: string; name?: string; captureBaseURL?: string }) =>
    call<NodeInfo>("GarrisonNode", "add", args),
  /** Selecting does not navigate; call reload() to land on the new node. */
  select: (name: string) => call<{ name: string }>("GarrisonNode", "select", { name }),
  remove: (name: string) => call<Record<string, never>>("GarrisonNode", "remove", { name }),
  reload: () => call<Record<string, never>>("GarrisonNode", "reload"),
  info: () => call<AppInfo>("GarrisonNode", "info")
};

export const nativeCapture = {
  status: () => call<CaptureStatus>("GarrisonCapture", "status"),
  start: (kind: CaptureKind, extra: Record<string, unknown> = {}) =>
    call<CaptureStatus>("GarrisonCapture", "start", { kind, ...extra }),
  stop: (kind: CaptureKind) => call<CaptureStatus>("GarrisonCapture", "stop", { kind }),
  consent: () => call<{ suppressed: boolean }>("GarrisonCapture", "consent"),
  setConsentSuppressed: (suppressed: boolean) =>
    call<{ suppressed: boolean }>("GarrisonCapture", "setConsentSuppressed", { suppressed }),
  onState: (cb: (status: CaptureStatus) => void) =>
    listen("GarrisonCapture", "captureState", cb as (data: never) => void)
};

export const nativePush = {
  register: () => call<PushStatus>("GarrisonPush", "register"),
  status: () => call<PushStatus>("GarrisonPush", "status"),
  /** A deep link the app received while the page was not listening. */
  pendingRoute: async (): Promise<string | null> => {
    const r = await call<{ path?: string }>("GarrisonPush", "pendingRoute");
    return typeof r?.path === "string" && r.path ? r.path : null;
  },
  onRoute: (cb: (route: { path: string }) => void) =>
    listen("GarrisonPush", "pushRoute", cb as (data: never) => void),
  onStatus: (cb: (status: PushStatus) => void) =>
    listen("GarrisonPush", "pushStatus", cb as (data: never) => void)
};

export const nativePendant = {
  status: () => call<PendantStatus>("GarrisonPendant", "status"),
  connect: () => call<PendantStatus>("GarrisonPendant", "connect"),
  disconnect: () => call<PendantStatus>("GarrisonPendant", "disconnect"),
  forget: () => call<PendantStatus>("GarrisonPendant", "forget"),
  onState: (cb: (status: PendantStatus) => void) =>
    listen("GarrisonPendant", "pendantState", cb as (data: never) => void),
  onBattery: (cb: (data: { battery: number }) => void) =>
    listen("GarrisonPendant", "pendantBattery", cb as (data: never) => void)
};

// A push payload's `path` is a shell route on the node that sent it, never a
// URL: rooted, single leading slash, no scheme. The same rule PushRouter.swift
// applies before it ever reaches the page; kept here too so a page that
// navigates on a `pushRoute` event trusts nothing it did not check.
export function isShellPath(path: unknown): path is string {
  if (typeof path !== "string") return false;
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  if (path.includes("://")) return false;
  return path.length <= 2048;
}

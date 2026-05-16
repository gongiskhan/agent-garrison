import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// One band for all services. Deterministic allocation within the band keeps
// dev ports stable per (branch, service) and lets a single sweep clear every
// Garrison-allocated process by port range.
//
// The defaults (50000–54999) are deliberately well above common dev ports;
// override via the GARRISON_PORT_RANGE_START / GARRISON_PORT_RANGE_END env
// vars or via a project's `port_pool: { start, end }` config block. See
// docs/DECISIONS.md (2026-05-16 "Worktree port pool stays 50000–54999,
// exposed via config").
export const DEFAULT_PORT_RANGE_START = 50000;
export const DEFAULT_PORT_RANGE_END = 54999;
const PROBE_LIMIT = 50;

export interface PortRange {
  start: number;
  end: number;
}

export function defaultPortRange(): PortRange {
  const envStart = Number(process.env.GARRISON_PORT_RANGE_START);
  const envEnd = Number(process.env.GARRISON_PORT_RANGE_END);
  const start =
    Number.isFinite(envStart) && envStart > 0 ? envStart : DEFAULT_PORT_RANGE_START;
  const end =
    Number.isFinite(envEnd) && envEnd > 0 ? envEnd : DEFAULT_PORT_RANGE_END;
  if (start >= end) {
    return { start: DEFAULT_PORT_RANGE_START, end: DEFAULT_PORT_RANGE_END };
  }
  return { start, end };
}

// Back-compat aliases — keep the old uppercase names exported so other code
// that imports them keeps working. They reflect the env-aware default range
// rather than literal constants.
export const GARRISON_PORT_RANGE_START = defaultPortRange().start;
export const GARRISON_PORT_RANGE_END = defaultPortRange().end;

function rangeSize(range: PortRange): number {
  return range.end - range.start + 1;
}

export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash =
      (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>>
      0;
  }
  return hash >>> 0;
}

export function basePort(branch: string, service: string, range: PortRange = defaultPortRange()): number {
  const offset = fnv1a32(`${branch}:${service}`) % rangeSize(range);
  return range.start + offset;
}

export function isPortInGarrisonRange(port: number, range: PortRange = defaultPortRange()): boolean {
  return port >= range.start && port <= range.end;
}

export async function isPortInUse(port: number): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "lsof",
      ["-iTCP:" + port, "-sTCP:LISTEN", "-t"],
      { encoding: "utf8" }
    );
    return Boolean(stdout && stdout.trim().length > 0);
  } catch {
    return false;
  }
}

export type AllocateOptions = {
  reserved?: Set<number>;
  isInUse?: (port: number) => Promise<boolean>;
  range?: PortRange;
};

export async function allocatePort(
  branch: string,
  service: string,
  opts: AllocateOptions = {}
): Promise<number> {
  const reserved = opts.reserved ?? new Set<number>();
  const isInUse = opts.isInUse ?? isPortInUse;
  const range = opts.range ?? defaultPortRange();
  const span = rangeSize(range);
  const candidate = basePort(branch, service, range);
  for (let i = 0; i < PROBE_LIMIT; i++) {
    const probe = candidate + i;
    const wrapped =
      probe > range.end ? range.start + ((probe - range.start) % span) : probe;
    if (reserved.has(wrapped)) continue;
    // eslint-disable-next-line no-await-in-loop
    if (!(await isInUse(wrapped))) {
      reserved.add(wrapped);
      return wrapped;
    }
  }
  throw new Error(`no free port for ${branch}:${service} after ${PROBE_LIMIT} probes`);
}

export async function allocatePortMap(
  branch: string,
  services: string[],
  opts: AllocateOptions = {}
): Promise<Record<string, number>> {
  const reserved = opts.reserved ?? new Set<number>();
  const ports: Record<string, number> = {};
  for (const service of services) {
    // eslint-disable-next-line no-await-in-loop
    ports[service] = await allocatePort(branch, service, { ...opts, reserved });
  }
  return ports;
}

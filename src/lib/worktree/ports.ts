import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// One band for all services. Deterministic allocation within the band keeps
// dev ports stable per (branch, service) and lets a single sweep clear every
// Garrison-allocated process by port range.
export const GARRISON_PORT_RANGE_START = 50000;
export const GARRISON_PORT_RANGE_END = 54999;
const GARRISON_PORT_RANGE_SIZE =
  GARRISON_PORT_RANGE_END - GARRISON_PORT_RANGE_START + 1;
const PROBE_LIMIT = 50;

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

export function basePort(branch: string, service: string): number {
  const offset = fnv1a32(`${branch}:${service}`) % GARRISON_PORT_RANGE_SIZE;
  return GARRISON_PORT_RANGE_START + offset;
}

export function isPortInGarrisonRange(port: number): boolean {
  return port >= GARRISON_PORT_RANGE_START && port <= GARRISON_PORT_RANGE_END;
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
};

export async function allocatePort(
  branch: string,
  service: string,
  opts: AllocateOptions = {}
): Promise<number> {
  const reserved = opts.reserved ?? new Set<number>();
  const isInUse = opts.isInUse ?? isPortInUse;
  const span = GARRISON_PORT_RANGE_SIZE;
  const candidate = basePort(branch, service);
  for (let i = 0; i < PROBE_LIMIT; i++) {
    const probe = candidate + i;
    const wrapped =
      probe > GARRISON_PORT_RANGE_END
        ? GARRISON_PORT_RANGE_START + ((probe - GARRISON_PORT_RANGE_START) % span)
        : probe;
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

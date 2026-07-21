import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

const GARRISON_DIR = process.env.GARRISON_HOME?.trim() || path.join(homedir(), ".garrison");
const HOSTS_PATH = path.join(GARRISON_DIR, "hosts.json");

const HostSchema = z.object({
  name: z.string().min(1),
  address: z.string().min(1),
  user: z.string().min(1),
});

const HostsSchema = z.array(HostSchema);

export type TrenchesHost = z.infer<typeof HostSchema>;

function ensureDir(): void {
  if (!existsSync(GARRISON_DIR)) {
    mkdirSync(GARRISON_DIR, { recursive: true, mode: 0o700 });
  }
}

export function readHosts(): TrenchesHost[] {
  if (!existsSync(HOSTS_PATH)) return [];
  try {
    const raw = readFileSync(HOSTS_PATH, "utf8");
    if (!raw.trim()) return [];
    const parsed = HostsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export function writeHosts(hosts: TrenchesHost[]): void {
  ensureDir();
  HostsSchema.parse(hosts);
  writeFileSync(HOSTS_PATH, JSON.stringify(hosts, null, 2), { mode: 0o600 });
}

export function upsertHost(host: TrenchesHost): TrenchesHost[] {
  HostSchema.parse(host);
  const hosts = readHosts();
  const next = hosts.filter((h) => h.name !== host.name);
  next.push(host);
  next.sort((a, b) => a.name.localeCompare(b.name));
  writeHosts(next);
  return next;
}

export function deleteHost(name: string): TrenchesHost[] {
  const hosts = readHosts().filter((h) => h.name !== name);
  writeHosts(hosts);
  return hosts;
}

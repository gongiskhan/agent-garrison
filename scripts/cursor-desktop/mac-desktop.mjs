import { execFileSync } from 'node:child_process';

export function macDesktopState(registry) {
  const root = Array.isArray(registry) ? registry[0] : registry;
  const users = root?.IOConsoleUsers;
  if (!Array.isArray(users)) return 'automation_blocked';
  const session = users.find(user => user.kCGSSessionOnConsoleKey === true);
  if (!session) return 'desktop_locked';
  if (session.CGSSessionScreenIsLocked === true || session.kCGSessionLoginDoneKey !== true) return 'desktop_locked';
  return 'available';
}

export function requireMacDesktop(run = execFileSync) {
  let state;
  try {
    const registry = run('/usr/sbin/ioreg', ['-n', 'Root', '-d1', '-a'], { timeout: 1500, maxBuffer: 1024 * 1024 });
    const json = run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: registry, timeout: 1500, maxBuffer: 1024 * 1024 });
    state = macDesktopState(JSON.parse(String(json)));
  } catch { throw new Error('automation_blocked'); }
  if (state !== 'available') throw new Error(state);
}

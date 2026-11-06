import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error Standalone Node module without declarations.
import { macDesktopState, requireMacDesktop } from '../scripts/cursor-desktop/mac-desktop.mjs';

const session = (patch = {}) => ({ IOConsoleUsers: [{ kCGSSessionOnConsoleKey: true, kCGSessionLoginDoneKey: true, ...patch }] });

describe('native desktop input preflight', () => {
  it('recognizes the measured locked console and a logged out console', () => {
    expect(macDesktopState(session({ CGSSessionScreenIsLocked: true }))).toBe('desktop_locked');
    expect(macDesktopState(session({ kCGSessionLoginDoneKey: false }))).toBe('desktop_locked');
    expect(macDesktopState(session({ kCGSSessionOnConsoleKey: false }))).toBe('desktop_locked');
  });
  it('accepts an unlocked logged in console, including an absent lock flag', () => {
    expect(macDesktopState(session({ CGSSessionScreenIsLocked: false }))).toBe('available');
    expect(macDesktopState(session())).toBe('available');
    expect(macDesktopState([session()])).toBe('available');
  });
  it('refuses missing or malformed detection results', () => {
    expect(macDesktopState([])).toBe('automation_blocked');
    expect(macDesktopState([{ IOConsoleUsers: 'unavailable' }])).toBe('automation_blocked');
    expect(() => requireMacDesktop(() => { throw new Error('denied'); })).toThrow('automation_blocked');
  });
  it('fails before any input with the precise locked reason', () => {
    const run = vi.fn().mockReturnValueOnce(Buffer.from('plist')).mockReturnValueOnce(JSON.stringify(session({ CGSSessionScreenIsLocked: true })));
    expect(() => requireMacDesktop(run)).toThrow('desktop_locked');
    expect(run.mock.calls.map(call => call[0])).toEqual(['/usr/sbin/ioreg', '/usr/bin/plutil']);
  });
});

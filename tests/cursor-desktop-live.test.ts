import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const base = process.env.GARRISON_CURSOR_LIVE_URL;
const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
describe('real Cursor desktop observation', () => {
  it.skipIf(!base || process.platform !== 'darwin')('shows a desktop prompt within five seconds, then renders its response and tools on a phone viewport', async () => {
    expect(new URL(base!).hostname).toBe('127.0.0.1');
    const scratch = path.join(os.homedir(), '.garrison/cursor-probe/probe.code-workspace');
    expect(fs.existsSync(scratch)).toBe(true);
    const nonce = randomBytes(4).toString('hex');
    const title = `Garrison P1 smoke ${nonce}`;
    const finalText = 'P1 complete. The scratch file was read, a scratch output file was written, and the shell command completed. This complete response is visible in Garrison.';
    const prompt = `${title}. Use only the two scratch roots. Read alpha/probe.txt with the built-in reader. Write alpha/p1-smoke.txt with the text cursor-live-ok. Run a shell command that waits six seconds and prints cursor-live-ok. Do not use connector tools. Finish by replying with exactly: ${finalText} [grs:${nonce}]`;
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-live-'));
    const job = `io.garrison.cursor.live-${nonce}`;
    const domain = `gui/${process.getuid!()}`;
    const driver = path.join(temp, 'driver.mjs');
    const resultFile = path.join(temp, 'result.json');
    const helper = path.resolve('scripts/cursor-desktop/enter.jxa.js');
    fs.writeFileSync(driver, `
      import {execFile} from 'node:child_process'; import {promisify} from 'node:util';
      import {setTimeout as delay} from 'node:timers/promises'; import fs from 'node:fs';
      const exec=promisify(execFile); const result={started_at:Date.now()};
      try {
        await exec('/Applications/Cursor.app/Contents/Resources/app/bin/cursor',['--reuse-window',${JSON.stringify(scratch)}],{timeout:8000});
        await delay(1500);
        await exec('/usr/bin/open',['cursor://anysphere.cursor-deeplink/prompt?text='+encodeURIComponent(${JSON.stringify(prompt)})],{timeout:5000});
        await delay(1500);
        await exec('/usr/bin/osascript',['-l','JavaScript',${JSON.stringify(helper)}],{timeout:5000});
        await delay(1500);
        await exec('/usr/bin/osascript',['-l','JavaScript',${JSON.stringify(helper)}],{timeout:5000});
        result.ok=true;
      } catch(error) { result.ok=false;result.error=error.message; }
      result.finished_at=Date.now();fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify(result),{mode:0o600});
    `, { mode: 0o600 });
    const plist = path.join(temp, 'job.plist');
    fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${job}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(driver)}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>LimitLoadToSessionType</key><string>Aqua</string><key>StandardErrorPath</key><string>${xml(path.join(temp, 'error.log'))}</string></dict></plist>`, { mode: 0o600 });
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const evidence = path.resolve('test-results/cursor-desktop'); fs.mkdirSync(evidence, { recursive: true });
    try {
      await page.goto(`${base}/talk`, { waitUntil: 'domcontentloaded' });
      await page.getByTestId('rail-filter-shells').waitFor({ state: 'attached', timeout: 30000 });
      if (!await page.getByTestId('rail-filter-shells').isVisible()) await page.getByRole('button', { name: 'Show conversations', exact: true }).click();
      await page.getByTestId('rail-filter-shells').click();
      await page.getByRole('searchbox', { name: 'Find conversations and sessions' }).fill(title);
      execFileSync('launchctl', ['bootstrap', domain, plist]);
      const row = page.getByTestId('rail-row').filter({ hasText: title });
      await row.waitFor({ timeout: 20000 });
      const seenAt = Date.now();
      expect(await row.getByText('Working', { exact: true }).isVisible()).toBe(true);
      await page.screenshot({ path: path.join(evidence, 'p1-live-phone-shells.png') });
      await row.getByRole('button').click();
      await page.getByTestId('cursor-state').waitFor();
      expect(await page.getByTestId('cursor-state').textContent()).toBe('Working');
      const list = await (await fetch(`${base}/api/cursor/conversations`)).json();
      const live = list.rows.find((r: any) => r.title?.startsWith(title));
      expect(live?.cursor).toBeTruthy();
      const response = await fetch(`${base}/api/cursor/conversations/${encodeURIComponent(live.node)}/${encodeURIComponent(live.id)}/stream`, { signal: AbortSignal.timeout(6000) });
      const reader = response.body!.getReader(); let data = '';
      while (!data.includes('\n\n')) data += new TextDecoder().decode((await reader.read()).value);
      await reader.cancel();
      const initial = JSON.parse(data.split('\n').find(line => line.startsWith('data: '))!.slice(6));
      const user = initial.events.find((e: any) => e.role === 'user');
      expect(user.blocks[0].text).toContain(title);
      expect(seenAt - user.ts).toBeLessThan(5000);
      await page.getByText(user.blocks[0].text, { exact: true }).waitFor({ timeout: 5000 });
      await page.screenshot({ path: path.join(evidence, 'p1-live-phone-working.png') });
      await page.getByText(finalText, { exact: true }).waitFor({ timeout: 90000 });
      const activity = page.locator('.cc-session-interim');
      for (const details of await activity.all()) if (!await details.getAttribute('open')) await details.locator('summary').first().click();
      expect(await page.getByText('Shell', { exact: true }).first().isVisible()).toBe(true);
      await page.screenshot({ path: path.join(evidence, 'p1-live-phone-response.png') });
      const driverResult = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
      expect(driverResult.ok).toBe(true);
      fs.writeFileSync(path.join(evidence, 'p1-live-result.json'), JSON.stringify({ prompt_to_shells_ms: seenAt - user.ts, full_response_visible: true, tool_visible: true, node: live.node, cursor_version: live.cursor.cursor_version }, null, 2) + '\n');
    } finally {
      await page.screenshot({ path: path.join(evidence, 'p1-live-final-state.png') }).catch(() => {});
      await browser.close();
      try { execFileSync('launchctl', ['bootout', `${domain}/${job}`], { stdio: 'ignore' }); } catch {}
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, 150000);
});

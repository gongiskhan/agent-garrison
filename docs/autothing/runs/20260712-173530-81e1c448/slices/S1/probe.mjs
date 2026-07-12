// Independent S1 functional probe (fresh-context adversarial test).
// Verifies the Quarters skills surface renders `design-taste-frontend` and
// `redesign-existing-projects`, each shown OWNED and owned by fitting `taste`,
// AND that /api/quarters records report state "owned" + fittingId "taste".
// Does NOT reuse any existing storyboard/test. Read-only; mutates nothing.
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:7777';
const TARGETS = ['design-taste-frontend', 'redesign-existing-projects'];
const OUT = new URL('.', import.meta.url).pathname;

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} :: ${detail}`);
}

// ---- API assertions (independent GET) ----
const apiRes = await fetch(`${BASE}/api/quarters`);
record('api.http.200', apiRes.status === 200, `GET /api/quarters -> ${apiRes.status}`);
const api = await apiRes.json();
const recs = Array.isArray(api.records) ? api.records : [];
for (const t of TARGETS) {
  const rec = recs.find((r) => r.name === t && r.surface === 'skill');
  if (!rec) {
    record(`api.${t}.present`, false, 'no skill record found');
    continue;
  }
  record(`api.${t}.present`, true, `id=${rec.id}`);
  record(`api.${t}.state=owned`, rec.state === 'owned', `state=${JSON.stringify(rec.state)}`);
  record(`api.${t}.fittingId=taste`, rec.fittingId === 'taste', `fittingId=${JSON.stringify(rec.fittingId)}`);
}

// ---- DOM assertions (real browser render) ----
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${BASE}/quarters/skills`, { waitUntil: 'networkidle', timeout: 30000 });
// Wait until at least one target name appears in the DOM (content hydrated).
try {
  await page.waitForFunction(
    (names) => names.some((n) => document.body.innerText.includes(n)),
    TARGETS,
    { timeout: 20000 },
  );
} catch {
  /* fall through to per-target assertions which will fail with detail */
}

const bodyText = await page.evaluate(() => document.body.innerText);

for (const t of TARGETS) {
  const inDom = bodyText.includes(t);
  record(`dom.${t}.rendered`, inDom, inDom ? 'name present in page text' : 'name NOT in page text');

  // Capture the row-level rendered text. Each skill row is a container keyed by
  // data-testid="primitive-skill:<id>"; its innerText carries the state pill
  // and owner marker. Fall back to climbing from the name text node.
  const rowInfo = await page.evaluate((name) => {
    const row = document.querySelector(`[data-testid="primitive-skill:${name}"]`);
    if (row) return (row.innerText || '').replace(/\s+/g, ' ').trim();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent && node.textContent.trim() === name) {
        let el = node.parentElement;
        for (let i = 0; i < 6 && el && el.parentElement; i++) {
          if ((el.innerText || '').toLowerCase().includes('owned')) break;
          el = el.parentElement;
        }
        return el ? el.innerText.replace(/\s+/g, ' ').trim() : null;
      }
    }
    return null;
  }, t);
  const rowLower = (rowInfo || '').toLowerCase();
  record(`dom.${t}.row.shows-owned`, rowLower.includes('owned'),
    `row text: ${rowInfo ? JSON.stringify(rowInfo) : 'NOT FOUND'}`);
  record(`dom.${t}.row.shows-taste`, rowLower.includes('taste'),
    `owner marker 'taste' ${rowLower.includes('taste') ? 'present' : 'absent'} in row`);
}

await page.screenshot({ path: OUT + 'skills-surface.png', fullPage: true });
await browser.close();

const failed = results.filter((r) => !r.pass);
console.log('\n==== SUMMARY ====');
console.log(`total=${results.length} pass=${results.length - failed.length} fail=${failed.length}`);
console.log(`VERDICT: ${failed.length === 0 ? 'PASS' : 'FAIL'}`);
process.exit(failed.length === 0 ? 0 : 1);

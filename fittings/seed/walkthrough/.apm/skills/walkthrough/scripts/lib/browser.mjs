// Record one browser segment: drive declarative beats with playwright-cli's
// screencast API, paint an in-page caption HUD per beat, assert + highlight the
// "verified result", and emit MEASURED beat offsets (elapsed since screencast
// start) via the return value — never inferred from assumed durations.
import { writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { pw, parseRunCodeResult } from './util.mjs';
import { FONT, CAPTION } from './style.mjs';

// Selector mini-language so the agent never writes raw Playwright in storyboards:
//   button:Save | link:Home | text:Welcome | label:Email | placeholder:Search
//   | testid:submit | role:heading:Title | otherwise treated as a CSS/locator string.
function resolverSource() {
  return `const resolve = (sel) => {
    if (sel.startsWith('button:')) return page.getByRole('button',{name:sel.slice(7)});
    if (sel.startsWith('link:')) return page.getByRole('link',{name:sel.slice(5)});
    if (sel.startsWith('text:')) return page.getByText(sel.slice(5));
    if (sel.startsWith('label:')) return page.getByLabel(sel.slice(6));
    if (sel.startsWith('placeholder:')) return page.getByPlaceholder(sel.slice(12));
    if (sel.startsWith('testid:')) return page.getByTestId(sel.slice(7));
    if (sel.startsWith('role:')) { const [, r, ...n] = sel.split(':'); return page.getByRole(r,{name:n.join(':')||undefined}); }
    return page.locator(sel);
  };`;
}

export function genBrowserScript(seg, webmPath, { width, height }) {
  const cfg = {
    out: webmPath,
    width,
    height,
    baseURL: seg.baseURL || '',
    startPath: seg.startPath || '/',
    // continue: reuse the session the previous segment left open (do NOT re-open
    // or re-navigate) — so a long operation kicked off earlier is still running
    // on this very page. waitBefore: an UNRECORDED wait for a completion signal
    // before the screencast starts (the "skip the boring middle" cut).
    cont: !!seg.continue,
    waitBefore: seg.waitBefore || null,
    // initScript: raw JS source (a string, NOT a function) registered via
    // page.addInitScript BEFORE the segment's first navigation, so it runs
    // before any app code on every subsequent load — for injecting a test-only
    // seam (e.g. a mocked getUserMedia + WS marker-frame relay, a forced
    // window.isSecureContext) that the app itself declares as an optional
    // `window` global a production page load never sets. Opt-in; absent by
    // default, so no existing storyboard is affected.
    initScript: seg.initScript || null,
    // settleReload: after the segment's FIRST navigation settles, reload once
    // more before any beat runs. Opt-in (default false, no existing storyboard
    // is affected) — for an app whose first hydration of a fresh deep-link can
    // race a client-side store init (observed: a fresh SPA session route
    // occasionally rendered its OWN generic empty-state instead of the
    // requested route on the very first paint, self-correcting on a reload).
    // Costs one extra reload's worth of time on a segment that starts clean.
    settleReload: !!seg.settleReload,
    // networkPanel: a live top-right HUD of real requests matching `match` (tested
    // against the request URL AND its TargetURL header, so proxy-tunnelled APIs
    // work). This is the "show the network tab" fallback — when a flow's proof is
    // the per-action network traffic, attach a panel instead of relying on devtools.
    netPanel: seg.networkPanel || null,
    beats: (seg.beats || []).map((b) => ({
      id: b.id,
      caption: b.caption || '',
      actions: b.actions || [],
      assert: b.assert || null,
      hold: b.hold ?? 3200,
      // holdUntil: keep the caption on screen and the camera rolling until this
      // selector appears (a long op finishing IN-shot, usually paired with a
      // segment `speed` so the wait is timelapsed). holdAfter: settle after it.
      holdUntil: b.holdUntil || null,
      holdAfter: b.holdAfter ?? 1500,
      expectFailure: !!b.expectFailure,
    })),
  };

  return `async page => {
  const CFG = ${JSON.stringify(cfg)};
  const { width:W, height:H } = CFG;
  await page.setViewportSize({ width: W, height: H });
  ${resolverSource()}
  // Resolve a selector to exactly ONE element. resolve() can match many nodes;
  // .first() then silently picks one (often hidden/wrong). pickOne resolves
  // ONCE, counts, keeps only VISIBLE matches, and pins to a single element
  // (base.nth(i)) so the cursor, the action and the highlight all share it.
  // 0 visible OR >1 visible (ambiguous) => { ok:false } so the beat FAILS
  // honestly rather than guessing.
  const pickOne = async (sel) => {
    const base = resolve(sel);
    let n = 0;
    try { n = await base.count(); } catch {}
    if (n === 0) { warnings.push('[walkthrough] selector "'+sel+'" matched 0 elements'); return { ok:false, sel, loc:null }; }
    const vis = [];
    for (let i = 0; i < n; i++) { try { if (await base.nth(i).isVisible()) vis.push(i); } catch {} }
    if (n > 1) warnings.push('[walkthrough] selector "'+sel+'" matched '+n+' elements; using first visible');
    if (vis.length === 0) { warnings.push('[walkthrough] selector "'+sel+'" matched '+n+' element(s) but none are visible'); return { ok:false, sel, loc:null }; }
    if (vis.length > 1) { warnings.push('[walkthrough] selector "'+sel+'" matched '+vis.length+' VISIBLE elements (ambiguous) — refusing to guess'); return { ok:false, sel, loc: base.nth(vis[0]) }; }
    return { ok:true, sel, loc: base.nth(vis[0]) };
  };
  let t0 = 0; // set at screencast start so beat offsets map onto the webm timeline
  const offsets = [];
  const results = [];
  // run-code's console.log is not surfaced, so non-fatal quality notes (multi-
  // match selectors, highlight clamps) are collected here and returned, then
  // printed by record.mjs.
  const warnings = [];
  // Register the test-only init script (if any) before any navigation happens
  // below (goto/waitBefore), so it is live for the segment's first page load
  // and every reload after — matching Playwright's own addInitScript contract.
  if (CFG.initScript) {
    try { await page.addInitScript(CFG.initScript); }
    catch (e) { warnings.push('[walkthrough] addInitScript failed: ' + String(e).split('\\n')[0]); }
  }
  let overlay = null;

  // Caption typography is centralised in scripts/lib/style.mjs and baked in by
  // VALUE here (this script runs in playwright-cli's VM and cannot import). The
  // CSS fade-in is best-effort: if showOverlay strips the <style>, the missing
  // @keyframes makes the animation a no-op and the caption renders at full
  // opacity — never invisible.
  const caption = async (text, fail) => {
    if (overlay && overlay.dispose) { try { await overlay.dispose(); } catch {} }
    const accent = fail ? '${CAPTION.accentFail}' : '${CAPTION.accent}';
    const scrim = fail ? '${CAPTION.scrimFail}' : '${CAPTION.scrim}';
    const pre = fail ? '<span style="color:${CAPTION.failText};font-weight:800">FAILED &mdash; </span>' : '';
    const box = 'position:absolute;left:0;right:0;bottom:0;padding:${CAPTION.padY}px ${CAPTION.padX}px;background:'+scrim+
      ';color:${CAPTION.fg};font-family:${FONT};border-top:4px solid '+accent+
      ';box-shadow:0 -10px 34px rgba(0,0,0,.5);animation:wtCapIn .28s ease-out both';
    const inner = 'max-width:${CAPTION.maxWidth}px;margin:0 auto;font-size:${CAPTION.fontSize}px;font-weight:${CAPTION.weight};' +
      'line-height:${CAPTION.lineHeight};letter-spacing:${CAPTION.letterSpacing}';
    overlay = await page.screencast.showOverlay(
      '<style>@keyframes wtCapIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}</style>' +
      '<div style="'+box+'"><div style="'+inner+'">'+pre+text+'</div></div>');
  };
  // Bring a target into view, then return its viewport box. Real apps put the
  // asserted element BELOW THE FOLD; measuring boundingBox without scrolling is
  // why highlights used to land off-screen (overlay coords are viewport-relative).
  const CAP_H = 96; // bottom caption HUD — never draw a box/cursor under it
  // Bring an ALREADY-PINNED locator into view and return a STABLE viewport box.
  // The old flat 300ms wait measured mid-layout; instead wait for fonts to load
  // (text reflow shifts boxes) then poll boundingBox until two reads ~120ms
  // apart agree (cap ~1s). overlay coords are viewport-relative, so a settled
  // measure is why the box lands ON the element.
  const inView = async (loc) => {
    await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    try { await page.evaluate(() => (document.fonts && document.fonts.ready) ? document.fonts.ready.then(() => true) : true); } catch {}
    let prev = null;
    const deadline = Date.now() + 1000;
    for (;;) {
      const b = await loc.boundingBox().catch(() => null);
      if (b && prev && b.x === prev.x && b.y === prev.y && b.width === prev.width && b.height === prev.height) return b;
      prev = b;
      if (Date.now() >= deadline) return b;
      await page.waitForTimeout(120);
    }
  };
  // Show a visible cursor + click pulse at the interaction point so the video
  // reads as a real user session, not an invisible headless test run.
  const pointerAt = async (loc) => {
    try {
      const b = await inView(loc);
      if (!b) return;
      const cx = Math.round(Math.min(W - 6, Math.max(6, b.x + b.width / 2)));
      const cy = Math.round(Math.min(H - CAP_H, Math.max(6, b.y + b.height / 2)));
      // Sticky (no duration) so it does NOT block-then-vanish before the click;
      // the caller disposes it right AFTER the action, so the cursor stays on the
      // target through the click. (showOverlay WITH a duration blocks for that long
      // then auto-removes — which would hide the cursor before the click lands.)
      const cur = await page.screencast.showOverlay(
        '<div style="position:absolute;left:'+cx+'px;top:'+cy+'px;z-index:60;pointer-events:none">'+
        '<div style="position:absolute;left:-25px;top:-25px;width:50px;height:50px;border-radius:50%;'+
        'background:rgba(20,184,166,.28);border:3px solid #14b8a6;box-shadow:0 0 16px rgba(20,184,166,.75)"></div>'+
        '<svg width="30" height="36" viewBox="0 0 30 36" style="position:absolute;left:-3px;top:-3px;filter:drop-shadow(0 1px 3px rgba(0,0,0,.6))">'+
        '<path d="M3 2 L3 27 L10 20.5 L14.5 33 L19.5 31 L15 18.5 L25 18.5 Z" fill="#fff" stroke="#0f172a" stroke-width="1.8"/></svg>'+
        '</div>');
      await page.waitForTimeout(550); // cursor sits on the target before the action
      return cur;
    } catch { return null; }
  };
  const disposeCursor = async (c) => { if (c && c.dispose) { try { await c.dispose(); } catch {} } };
  const highlight = async (loc, sel) => {
    try {
      let b = await inView(loc);
      if (!b) return;
      // A tall / below-fold target used to be SILENTLY shrunk to fit above the
      // caption bar, so the box stopped framing the element. Warn, try to
      // re-center the element higher and re-measure; if it's pinned to the
      // bottom (e.g. a composer Send button) and can't move, frame it ANYWAY —
      // the box is drawn AFTER the caption so its border stays visible on top,
      // which beats a useless sliver clamped above the bar.
      if (b.height > H - CAP_H || b.y + b.height > H - CAP_H || b.y < 0) {
        warnings.push('[walkthrough] highlight clamp on "'+(sel||'')+'" (target overlaps the caption bar) — re-centered / framed over the bar');
        try { await loc.evaluate((el) => el.scrollIntoView({ block: 'center' })); } catch {}
        const nb = await inView(loc);
        if (nb) b = nb;
      }
      const pad = 6;
      const x = Math.max(2, b.x - pad);
      const y = Math.max(2, b.y - pad);
      const w = Math.max(8, Math.min(W - x - 2, b.width + pad * 2));
      // Bound to the VIEWPORT (not H-CAP_H): keep the box framing the element
      // even when it sits in the caption zone, instead of shrinking it to a sliver.
      const h = Math.max(8, Math.min(H - y - 2, b.height + pad * 2));
      await page.screencast.showOverlay(
        '<div style="position:absolute;top:'+y+'px;left:'+x+'px;width:'+w+
        'px;height:'+h+'px;border:3px solid #facc15;border-radius:10px;'+
        'box-shadow:0 0 0 9999px rgba(0,0,0,.12)"></div>', { duration: 2600 });
    } catch {}
  };
  const runAction = async (a) => {
    if (a.type==='goto') await page.goto(/^https?:\\/\\//.test(a.path) ? a.path : CFG.baseURL + a.path, { waitUntil: a.waitUntil || 'load' });
    else if (a.type==='gotoApp') {
      // Navigate the TOP-LEVEL page to the URL embedded in the live preview
      // iframe (e.g. an Ekoa-built app under /apps/<id>/), so the finished
      // artifact from THIS build can be shown and asserted top-level (the
      // cross-origin iframe cannot be asserted into). a.match overrides the
      // default /apps/ pattern.
      const re = new RegExp(a.match || '/apps/');
      const src = await page.evaluate((p) => {
        const f = [...document.querySelectorAll('iframe')].find((i) => new RegExp(p).test(i.src || ''));
        return f ? f.src.split('?')[0] : null;
      }, re.source);
      if (!src) throw new Error('gotoApp: no iframe matching ' + re.source + ' found');
      await page.goto(src, { waitUntil: a.waitUntil || 'load' });
    }
    else if (a.type==='goBack') await page.goBack({ waitUntil: a.waitUntil || 'load' });
    else if (a.type==='click') { const p = await pickOne(a.selector); if (!p.ok) throw new Error('click: selector not uniquely resolvable: '+a.selector); const c = await pointerAt(p.loc); await p.loc.click({ timeout: a.timeout||15000, force: !!a.force }); await disposeCursor(c); }
    else if (a.type==='fill') { const p = await pickOne(a.selector); if (!p.ok) throw new Error('fill: selector not uniquely resolvable: '+a.selector); const c = await pointerAt(p.loc); await p.loc.click({ force: !!a.force }); await disposeCursor(c); await p.loc.fill(''); await p.loc.pressSequentially(a.text, { delay: 55 }); }
    else if (a.type==='select') { const p = await pickOne(a.selector); if (!p.ok) throw new Error('select: selector not uniquely resolvable: '+a.selector); const c = await pointerAt(p.loc); await p.loc.selectOption(a.value); await disposeCursor(c); await page.waitForTimeout(250); }
    else if (a.type==='press') await page.keyboard.press(a.key);
    else if (a.type==='hover') { const p = await pickOne(a.selector); if (!p.ok) throw new Error('hover: selector not uniquely resolvable: '+a.selector); const c = await pointerAt(p.loc); await p.loc.hover(); await page.waitForTimeout(350); await disposeCursor(c); }
    else if (a.type==='waitFor') await resolve(a.selector).first().waitFor({ state:a.state||'visible', timeout:a.timeout||15000 });
    else if (a.type==='waitTimeout') await page.waitForTimeout(a.ms||1000);
    else if (a.type==='evaluate') {
      // a.script is a (arrow or function) expression SOURCE, e.g. "() => foo()" or
      // "async () => { await bar(); }" - NOT a statement list. page.evaluate(string)
      // evaluates the string as a bare expression and does NOT auto-invoke a
      // function-expression string (unlike passing an actual Function value, which
      // Playwright wraps and calls) - so it must be wrapped as an IIFE call here, or
      // the action silently constructs-and-discards the function without running it.
      try { await page.evaluate('(' + a.script + ')()'); }
      catch (e) { throw new Error('evaluate failed: '+String(e).split('\\n')[0]); }
    }
    else if (a.type==='mousePress') {
      // Press-and-hold gesture (mouse down, wait holdMs, mouse up) — for UI that
      // distinguishes a tap from a hold (e.g. a talking-mode mic gesture). A plain
      // click cannot express the hold; this mirrors page.mouse.down/up used
      // directly in Playwright tests of the same gesture.
      const p = await pickOne(a.selector);
      if (!p.ok) throw new Error('mousePress: selector not uniquely resolvable: '+a.selector);
      const b = await inView(p.loc);
      if (!b) throw new Error('mousePress: target has no box: '+a.selector);
      const cx = b.x + b.width/2, cy = b.y + b.height/2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.waitForTimeout(a.holdMs || 650);
      await page.mouse.up();
    }
    else if (a.type==='upload') {
      if (a.trigger) {
        const [fc] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: a.timeout||15000 }),
          resolve(a.trigger).first().click(),
        ]);
        await fc.setFiles(a.file);
      } else { await resolve(a.selector).first().setInputFiles(a.file); }
    }
  };

  // --- network panel: a live HUD of matching requests, rendered as a sticky
  // top-right overlay that re-paints as calls land. This is the "network tab"
  // proof for flows whose evidence IS the per-action traffic (e.g. server-side
  // pagination firing one request per page). Attached BEFORE navigation so it
  // catches every call.
  const NP = CFG.netPanel;
  let netOverlay = null;
  const netCalls = [];
  const pendReq = new Map();
  const getPath = (o, p) => {
    if (o == null) return undefined;
    let v = o;
    for (const k of String(p).split('.')) {
      if (k === 'length') return Array.isArray(v) ? v.length : (v == null ? undefined : v.length);
      v = v == null ? undefined : v[k];
    }
    return v;
  };
  const renderNet = async () => {
    if (!NP) return;
    if (netOverlay && netOverlay.dispose) { try { await netOverlay.dispose(); } catch {} }
    const rows = netCalls.slice(-(NP.max || 8))
      .map((c) => '<div style="padding:3px 0;color:#a7f3d0;white-space:nowrap">' + c + '</div>').join('');
    netOverlay = await page.screencast.showOverlay(
      '<div style="position:absolute;top:14px;right:14px;width:' + (NP.width || 480) +
      'px;z-index:55;background:rgba(2,6,23,.95);border:1px solid #334155;border-radius:10px;padding:12px 14px;' +
      'font:13px ui-monospace,SFMono-Regular,Menlo,monospace;box-shadow:0 6px 26px rgba(0,0,0,.55)">' +
      '<div style="color:#fff;font-weight:700;margin-bottom:8px;font-family:-apple-system,Helvetica,Arial,sans-serif">' +
      'NETWORK &middot; ' + (NP.title || '') + '</div>' + (rows || '<div style="color:#64748b">waiting&hellip;</div>') + '</div>');
  };
  if (NP) {
    const hit = (url, target) => (url && url.includes(NP.match)) || (target && target.includes(NP.match));
    const passFilter = (body) => {
      const f = NP.filter; if (!f) return true;
      const v = getPath(body, f.path);
      if (f.equals !== undefined && v !== f.equals) return false;
      if (f.max !== undefined && !(Number(v) <= f.max)) return false;
      if (f.min !== undefined && !(Number(v) >= f.min)) return false;
      return true;
    };
    page.on('request', (req) => {
      try {
        const h = req.headers();
        const target = h['targeturl'] || h['TargetURL'] || '';
        if (!hit(req.url(), target)) return;
        let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch {}
        if (!passFilter(body)) return;
        pendReq.set(req, body);
      } catch {}
    });
    page.on('response', async (res) => {
      try {
        const req = res.request();
        if (!pendReq.has(req)) return;
        const body = pendReq.get(req); pendReq.delete(req);
        let resBody = null; try { resBody = await res.json(); } catch {}
        const reqParts = Object.entries(NP.request || {}).map(([k, p]) => k + ': ' + getPath(body, p));
        const resParts = Object.entries(NP.response || {}).map(([k, p]) => k + ': ' + getPath(resBody, p));
        let line = '&#9654; ';
        if (reqParts.length) line += '{ ' + reqParts.join(', ') + ' }  ';
        line += '&rarr; ' + res.status();
        if (resParts.length) line += '  &middot;  ' + resParts.join(', ');
        netCalls.push(line);
        await renderNet();
      } catch {}
    });
  }

  // UNRECORDED pre-roll: wait for a long operation to finish off-camera before
  // we start rolling (the "skip the boring middle" cut). Runs on the page the
  // previous segment left open.
  if (CFG.waitBefore) {
    try { await resolve(CFG.waitBefore.selector).first().waitFor({ state: CFG.waitBefore.state || 'visible', timeout: CFG.waitBefore.timeout || 300000 }); } catch {}
  }
  await page.screencast.start({ path: CFG.out, size: { width: W, height: H } });
  t0 = Date.now();
  // Fresh segments navigate to the start path; a continue segment stays on the
  // page (and live state) the previous segment left behind.
  if (!CFG.cont) { try { await page.goto(CFG.baseURL + CFG.startPath, { waitUntil:'load' }); } catch {} }
  await page.waitForTimeout(500);
  if (!CFG.cont && CFG.settleReload) {
    try { await page.reload({ waitUntil: 'load' }); } catch {}
    await page.waitForTimeout(500);
  }
  if (NP) { try { await renderNet(); } catch {} }

  for (const beat of CFG.beats) {
    let ok = true, err = null;
    // Dispose the prior beat's caption HUD before running this beat's actions —
    // it sits at the bottom and would otherwise cover a bottom-anchored composer/
    // input, making a same-page follow-up interaction (e.g. a chat 2nd turn) fail.
    if (overlay && overlay.dispose) { try { await overlay.dispose(); } catch {} overlay = null; }
    for (const a of (beat.actions||[])) {
      try { await runAction(a); }
      catch (e) { ok = false; err = String(e).split('\\n')[0]; }
    }
    let assertLoc = null;
    if (beat.assert) {
      try {
        // Preserve the appearance-wait on the raw selector (ANY match becoming
        // visible), then pin to ONE element and run every check + the highlight
        // on that SAME element (was: re-resolved independently each time).
        await resolve(beat.assert.selector).first().waitFor({ state:'visible', timeout: beat.assert.timeout||15000 });
        const p = await pickOne(beat.assert.selector);
        if (!p.ok) throw new Error('assert: selector not uniquely resolvable: '+beat.assert.selector);
        assertLoc = p.loc;
        if (beat.assert.text) {
          // The verified content may stream in AFTER the element first appears
          // (e.g. an assistant reply completing), so poll innerText up to the
          // assert timeout instead of reading once.
          const deadline = Date.now() + (beat.assert.timeout||15000);
          let tx = '';
          for (;;) {
            try { tx = await assertLoc.innerText(); } catch { tx = ''; }
            if (tx.includes(beat.assert.text)) break;
            if (Date.now() >= deadline) throw new Error('assert text mismatch; saw: '+tx.slice(0,80));
            await page.waitForTimeout(400);
          }
        }
        if (beat.assert.enabled === true && !(await assertLoc.isEnabled())) throw new Error('expected element to be enabled');
        if (beat.assert.enabled === false && (await assertLoc.isEnabled())) throw new Error('expected element to be disabled');
      } catch (e) { ok = false; err = String(e).split('\\n')[0]; assertLoc = null; }
    }
    // MEASURED offset at the moment this beat's caption goes up.
    offsets.push({ id: beat.id, offsetMs: Date.now() - t0 });
    const showFail = beat.expectFailure || !ok;
    await caption(beat.caption, showFail);
    if (beat.assert && beat.assert.highlight && ok && !beat.expectFailure && assertLoc) {
      await highlight(assertLoc, beat.assert.selector);
    }
    // Long op finishing IN-shot: keep the caption up and the camera rolling until
    // the completion signal appears (usually paired with a segment speed factor so
    // the wait is timelapsed). If it never appears, the op did not complete on
    // camera — flag the run and flip the caption to FAILED honestly.
    if (beat.holdUntil) {
      try { await resolve(beat.holdUntil.selector).first().waitFor({ state: beat.holdUntil.state || 'visible', timeout: beat.holdUntil.timeout || 300000 }); }
      catch (e) {
        ok = false; err = err || ('holdUntil never appeared: ' + String(e).split('\\n')[0]);
        if (!beat.expectFailure) await caption(beat.caption, true);
      }
      await page.waitForTimeout(beat.holdAfter || 1500);
    } else {
      await page.waitForTimeout(beat.hold || 2400);
    }
    // A correctly-shown expected-failure is a PASS for the run's honesty gate.
    results.push({ id: beat.id, ok, expectFailure: !!beat.expectFailure, err });
  }
  if (overlay && overlay.dispose) { try { await overlay.dispose(); } catch {} }
  await page.screencast.stop();
  return JSON.stringify({ offsets, results, warnings });
}`;
}

// opts.keepOpen — do NOT close the browser when this segment ends, because the
// next browser segment is a `continue` and needs the live session (and any
// long operation still running in it) to persist.
export async function recordBrowserSegment(seg, ctx, opts = {}) {
  const { workDir, video } = ctx;
  const webm = path.join(workDir, `seg-${seg.id}.webm`);
  if (!seg.continue) {
    // Fresh session: close this run's recording session if one is lingering,
    // then open + auth + size. Scoped `close` (not the workspace-wide
    // `close-all`) so a concurrent run's browser is never touched — see
    // util.pw / runScope for why each run has its own daemon namespace.
    await pw(['close'], workDir).catch(() => {});
    await pw(['open', 'about:blank'], workDir);
    if (seg.authState) {
      // playwright-cli sandboxes state files to its cwd, so copy the repo's auth
      // state into the run's work dir and load it by basename.
      const local = path.join(workDir, 'auth.json');
      copyFileSync(path.resolve(seg.authState), local);
      const r = await pw(['state-load', 'auth.json'], workDir);
      if (r.code !== 0) throw new Error(`state-load failed for ${seg.authState}: ${r.stderr || r.stdout}`);
    }
    await pw(['resize', String(video.width), String(video.height)], workDir);
  }
  // A `continue` segment reuses the browser/page the previous segment left open
  // — no close, no open, no re-navigation.

  const scriptPath = path.join(workDir, `seg-${seg.id}.js`);
  writeFileSync(scriptPath, genBrowserScript(seg, webm, video));
  const r = await pw(['run-code', `--filename`, scriptPath], workDir, { timeoutMs: seg.runTimeoutMs || 600000 });
  const parsed = parseRunCodeResult(r.stdout);
  if (!parsed) {
    throw new Error(`browser segment ${seg.id} produced no parseable result.\nstdout tail:\n${r.stdout.slice(-800)}\nstderr:\n${r.stderr.slice(-400)}`);
  }
  if (!opts.keepOpen) await pw(['close'], workDir).catch(() => {});
  return { raw: webm, offsets: parsed.offsets, results: parsed.results, warnings: parsed.warnings || [] };
}

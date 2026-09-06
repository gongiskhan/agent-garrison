import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let bundle: string;
beforeAll(async () => {
  const output = await build({
    stdin: { resolveDir: path.resolve(__dirname, ".."), sourcefile: "audio-fixture.tsx", loader: "tsx", contents: `
      import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
      import {VoiceConversation} from './packages/talk/ui/voice-conversation';
      import {RecordButton} from './packages/talk/ui/record-button';
      const idle = {phase:'idle',broadcasting:false}; let state = idle; let listener;
      window.captureStatus = value => { state = value; listener?.(value); };
      window.captureStarts = [];
      const bridge = { status: async()=>state, onState: async cb=>{listener=cb;return {remove(){}}},
        start: async(kind, extra)=>{window.captureStarts.push({kind,...extra}); return state={...idle,broadcasting:true};},
        stop: async()=>state=idle };
      function Fixture(){const [draft,setDraft]=useState('Keep my typed draft'); return <>
        <textarea aria-label="Draft" value={draft} onChange={e=>setDraft(e.target.value)}/>
        <VoiceConversation assumeAvailable draft={draft} setDraft={setDraft} send={()=>{throw Error('Dictation must not send')}}/>
        <RecordButton bridge={bridge} conversationId="qa-audio" feedback={false}/>
      </>}; createRoot(document.getElementById('root')).render(<Fixture/>);` },
    bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
  });
  bundle = output.outputFiles[0].text;
  browser = await chromium.launch({ headless: true });
}, 60_000);
afterAll(async () => { await browser?.close(); });

async function fixture() {
  const page = await browser.newPage();
  await page.route("https://audio.test/**", async route => {
    if (new URL(route.request().url()).pathname === "/") return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
    return route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "Transcription provider unavailable" }) });
  });
  await page.goto("https://audio.test/");
  await page.evaluate(() => {
    const w = window as any;
    w.trackStops = 0;
    const track = new EventTarget() as any;
    track.stop = () => w.trackStops++;
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      getUserMedia: async () => {
        if (w.permissionFailure) throw new Error("Microphone permission denied");
        return { getTracks: () => [track], getAudioTracks: () => [track] };
      },
    } });
    w.AudioContext = class {
      state = "running";
      resume() { return Promise.resolve(); }
      close() { this.state = "closed"; return Promise.resolve(); }
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      createAnalyser() { return { fftSize: 1024, getByteTimeDomainData(data: Uint8Array) { data.fill(128); } }; }
    };
    w.MediaRecorder = class {
      static isTypeSupported() { return true; }
      state = "inactive"; mimeType = "audio/webm";
      onerror?: () => void; onstop?: () => void; ondataavailable?: (event: {data: Blob}) => void;
      constructor() { w.recorder = this; }
      start() { this.state = "recording"; }
      stop() { this.state = "inactive"; this.ondataavailable?.({data: new Blob(['synthetic phone audio'])}); this.onstop?.(); }
    };
  });
  await page.addScriptTag({ content: bundle });
  await page.getByRole("button", { name: "Dictate", exact: true }).waitFor();
  return page;
}

async function assertRetryAndDraft(page: Page, error: RegExp) {
  await expect.poll(() => page.getByRole("button", { name: "Dictate", exact: true }).count()).toBe(1);
  expect(await page.getByRole("textbox", { name: "Draft" }).inputValue()).toBe("Keep my typed draft");
  expect(await page.getByText(error).isVisible()).toBe(true);
  expect(await page.evaluate(() => (window as any).trackStops)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Dictate", exact: true }).click();
  await page.getByRole("button", { name: "Stop dictating", exact: true }).waitFor();
}

it("shows a live recorder failure, releases the phone mic and allows retry without losing or sending the draft", async () => {
  const page = await fixture();
  try {
    await page.getByRole("button", { name: "Dictate", exact: true }).click();
    await page.getByRole("button", { name: "Stop dictating", exact: true }).waitFor();
    await page.evaluate(() => (window as any).recorder.onerror());
    await assertRetryAndDraft(page, /Microphone recorder failed/);
  } finally { await page.close(); }
});

it("shows a REST transcription failure instead of staying on Finishing or Dictating", async () => {
  const page = await fixture();
  try {
    await page.getByRole("button", { name: "Dictate", exact: true }).click();
    await page.getByRole("button", { name: "Stop dictating", exact: true }).click();
    await assertRetryAndDraft(page, /transcription failed \(502\)/);
  } finally { await page.close(); }
});

it("explains the user-owned broadcast microphone switch, forwards the same capture request and shows a native failure", async () => {
  const page = await fixture();
  try {
    const record = page.getByRole("button", { name: "Record screen", exact: true });
    expect(await record.getAttribute("title")).toContain("Turn Microphone On");
    await record.click();
    await page.getByRole("button", { name: "Stop recording", exact: true }).waitFor();
    expect(await page.getByTestId("wc-rec-hint").innerText()).toContain("keep Microphone On");
    expect(await page.evaluate(() => (window as any).captureStarts)).toEqual([{kind: "screen_audio", conversationId: "qa-audio"}]);
    await page.evaluate(() => (window as any).captureStatus({phase: "idle", broadcasting: false, broadcastError: "Broadcast microphone connection lost"}));
    await page.getByRole("button", { name: "Record screen", exact: true }).waitFor();
    expect(await page.getByText("Broadcast microphone connection lost").isVisible()).toBe(true);
  } finally { await page.close(); }
});

it("returns to a retryable idle control after microphone permission denial and keeps the typed draft", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => { (window as any).permissionFailure = true; });
    await page.getByRole("button", { name: "Dictate", exact: true }).click();
    await page.getByText("Microphone permission denied", {exact: true}).waitFor();
    expect(await page.getByRole("button", { name: "Dictate", exact: true }).isEnabled()).toBe(true);
    expect(await page.getByRole("textbox", { name: "Draft" }).inputValue()).toBe("Keep my typed draft");
    await page.evaluate(() => { (window as any).permissionFailure = false; });
    await page.getByRole("button", { name: "Dictate", exact: true }).click();
    await page.getByRole("button", { name: "Stop dictating", exact: true }).waitFor();
  } finally { await page.close(); }
});

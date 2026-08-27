// STT regression harness: replay the raw opus packets of any captured
// session (media/<id>/audio.log) against the Deepgram LIVE websocket with
// arbitrary query params — the tool that proved language=multi produced
// garbage from good audio (2026-08-13) and that language=pt + keyterm fixed
// it. Pair with audio-log-to-ogg.py to get a listenable/prerecorded WAV.
//
// usage: DEEPGRAM_API_KEY=... node replay-stt.mjs <audio.log> \
//          "model=nova-3&language=pt&smart_format=true&interim_results=true&keyterm=Zeca" [paceMs]
// paceMs 20 = real-time; 0 = firehose (fast, but can cost trailing words).
// The key is only ever sent to api.deepgram.com; never printed.
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';

const [logPath, params, paceStr] = process.argv.slice(2);
const pace = paceStr ? Number(paceStr) : 20;
const key = process.env.DEEPGRAM_API_KEY || process.env.DG_KEY;
if (!key) { console.error('set DEEPGRAM_API_KEY'); process.exit(1); }

const data = readFileSync(logPath);
const pkts = [];
let off = 0;
while (off + 16 <= data.length) {
  const len = data.readUInt32LE(off + 12);
  off += 16;
  if (off + len > data.length) break;
  pkts.push(data.subarray(off, off + len));
  off += len;
}
console.error(`packets=${pkts.length}`);

const url = `wss://api.deepgram.com/v1/listen?encoding=opus&sample_rate=16000&${params}`;
const ws = new WebSocket(url, { headers: { Authorization: `Token ${key}` } });

const finals = [];
const interims = [];
ws.on('open', async () => {
  console.error('ws open, streaming...');
  for (const p of pkts) {
    ws.send(p);
    if (pace > 0) await new Promise(r => setTimeout(r, pace));
  }
  ws.send(JSON.stringify({ type: 'CloseStream' }));
});
ws.on('message', (m) => {
  try {
    const d = JSON.parse(m.toString());
    if (d.type === 'Results') {
      const alt = d.channel?.alternatives?.[0];
      if (!alt) return;
      const rec = { t: alt.transcript, conf: alt.confidence, final: d.is_final, langs: (alt.languages || d.channel?.languages) };
      if (d.is_final) { if (rec.t) finals.push(rec); }
      else if (rec.t) interims.push(rec);
    }
  } catch {}
});
ws.on('close', () => {
  console.log(JSON.stringify({ finals, interims: interims.slice(0, 40) }, null, 1));
  process.exit(0);
});
ws.on('error', (e) => { console.error('WS error:', e.message); process.exit(2); });
setTimeout(() => { console.error('timeout'); console.log(JSON.stringify({ finals, interims }, null, 1)); process.exit(3); }, 120000);

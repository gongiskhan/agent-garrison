// count-sections.mjs — exact, provider-authoritative attribution of the boot
// prefix, using /v1/messages/count_tokens rather than a local estimator.
//
// The credentials never touch disk. The proxy holds the live request's headers
// in memory for the duration of the process and this module reuses them for the
// counting calls; only integers are written out.
import https from "node:https";

const COUNT_PATH = "/v1/messages/count_tokens";

function post(headers, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = https.request({
      hostname: "api.anthropic.com", port: 443, path: COUNT_PATH, method: "POST",
      headers: {
        ...headers,
        host: "api.anthropic.com",
        "content-type": "application/json",
        "content-length": payload.length,
        "accept-encoding": "identity",
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode !== 200) return reject(new Error(`${res.statusCode} ${text.slice(0, 300)}`));
        try { resolve(JSON.parse(text)); } catch (e) { reject(new Error(`unparseable: ${text.slice(0, 200)}`)); }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// Strip the hop-by-hop and length headers; keep auth + anthropic-version + betas
// so the count is computed under exactly the request's own contract.
function countHeaders(raw) {
  const keep = ["authorization", "x-api-key", "anthropic-version", "anthropic-beta", "user-agent",
                "x-app", "anthropic-dangerous-direct-browser-access"];
  const out = {};
  for (const k of keep) if (raw[k]) out[k] = raw[k];
  return out;
}

const DUMMY = [{ role: "user", content: "x" }];

export async function countSections({ headers, body, appendText }) {
  const h = countHeaders(headers);
  const model = body.model;
  const sys = Array.isArray(body.system) ? body.system : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const msgs = body.messages ?? DUMMY;
  const out = { model, sections: {}, tools: {}, systemBlocks: [], notes: [] };

  const count = async (label, payload) => {
    const r = await post(h, { model, ...payload });
    return r.input_tokens;
  };

  // The zero point: what an empty request costs, so every section below is a
  // marginal number rather than one that silently carries the envelope.
  out.sections.floor = await count("floor", { messages: DUMMY });
  out.sections.whole = await count("whole", { system: sys, tools, messages: msgs });
  out.sections.systemAll = await count("systemAll", { system: sys, messages: DUMMY }) - out.sections.floor;
  out.sections.toolsAll = await count("toolsAll", { tools, messages: DUMMY }) - out.sections.floor;
  out.sections.messages = await count("messages", { messages: msgs }) - out.sections.floor;

  for (let i = 0; i < sys.length; i++) {
    const n = await count(`sys${i}`, { system: [sys[i]], messages: DUMMY }) - out.sections.floor;
    out.systemBlocks.push({ index: i, chars: (sys[i].text ?? "").length, tokens: n });
  }

  // The Claude Code preset and the composition's assembled prompt arrive
  // concatenated in ONE system block. Split on the assembled text so the two are
  // reported separately - which of them to cut is the whole question.
  if (appendText) {
    const big = sys.find((b) => typeof b.text === "string" && b.text.includes(appendText.slice(0, 200)));
    if (big) {
      const idx = big.text.indexOf(appendText.slice(0, 200));
      const presetPart = big.text.slice(0, idx);
      const appendPart = big.text.slice(idx);
      out.sections.presetPrompt = await count("preset", { system: [{ type: "text", text: presetPart }], messages: DUMMY }) - out.sections.floor;
      out.sections.appendedPrompt = await count("append", { system: [{ type: "text", text: appendPart }], messages: DUMMY }) - out.sections.floor;
      out.notes.push(`split system block at offset ${idx}: preset ${presetPart.length} chars, appended ${appendPart.length} chars`);
    } else {
      out.notes.push("appended prompt not found inside any system block - not split");
    }
  }

  for (const t of tools) {
    const n = await count(t.name, { tools: [t], messages: DUMMY }) - out.sections.floor;
    out.tools[t.name] = n;
  }

  // Each user-message block on its own, so the injected system-reminders
  // (agent list, skills list, claudeMd/memory) are separable from the prompt.
  out.messageBlocks = [];
  const first = msgs[0];
  if (first && Array.isArray(first.content)) {
    for (let i = 0; i < first.content.length; i++) {
      const blk = first.content[i];
      const n = await count(`msg${i}`, { messages: [{ role: "user", content: [blk] }] }) - out.sections.floor;
      const text = typeof blk.text === "string" ? blk.text : "";
      out.messageBlocks.push({
        index: i, chars: text.length, tokens: n,
        label: text.startsWith("<system-reminder>")
          ? text.slice(0, 120).replace(/\s+/g, " ")
          : "(the prompt)",
      });
    }
  }
  return out;
}

// Exact cost of a tool SUBSET, counted as a whole rather than summed per tool
// (a per-tool count carries the inventory framing, so summing them overstates
// the total by roughly 500 tokens a tool).
export async function countToolSubsets({ headers, body, subsets }) {
  const h = countHeaders(headers);
  const model = body.model;
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const byName = new Map(tools.map((t) => [t.name, t]));
  const count = async (payload) => (await post(h, { model, ...payload })).input_tokens;
  const floor = await count({ messages: DUMMY });
  const out = { floor, all: (await count({ tools, messages: DUMMY })) - floor, subsets: {} };
  for (const [label, names] of Object.entries(subsets)) {
    const picked = names.map((n) => byName.get(n)).filter(Boolean);
    const missing = names.filter((n) => !byName.has(n));
    out.subsets[label] = {
      kept: picked.map((t) => t.name),
      missing,
      tokens: picked.length ? (await count({ tools: picked, messages: DUMMY })) - floor : 0,
    };
  }
  return out;
}

// Count arbitrary named text fragments (used to break the composition's
// assembled prompt into its own sections).
export async function countTexts({ headers, body, texts }) {
  const h = countHeaders(headers);
  const model = body.model;
  const count = async (payload) => (await post(h, { model, ...payload })).input_tokens;
  const floor = await count({ messages: DUMMY });
  const out = { floor, sections: {} };
  for (const [label, text] of Object.entries(texts)) {
    out.sections[label] = {
      chars: text.length,
      tokens: (await count({ system: [{ type: "text", text }], messages: DUMMY })) - floor,
    };
  }
  return out;
}

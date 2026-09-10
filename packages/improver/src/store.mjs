import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createStateClient } from "@garrison/state-client";
import { TRACKS, initialTrack } from "./contracts.mjs";

export function clientFor(env = process.env) {
  return createStateClient({ env: { ...env, GARRISON_HOME: env.GARRISON_HOME || path.join(os.homedir(), ".garrison") }, readFileSync: fs.readFileSync });
}
export class ImprovementStore {
  constructor(client = clientFor()) { this.client = client; }
  namespace(kind, id) {
    if (!/^[a-z]+$/.test(kind) || !/^[A-Za-z0-9._:-]{1,180}$/.test(id)) throw new Error("Invalid improvement record identity");
    return `improver.${kind}.${id}`;
  }
  async read(kind, id) { return this.client.getConfig(this.namespace(kind,id), "global"); }
  async list(kind) {
    const rows = await this.client.listConfig(`improver.${kind}.`);
    const result = [];
    for (let i = 0; i < rows.length; i += 20) {
      const docs = await Promise.all(rows.slice(i,i+20).map((row) => this.client.getConfig(row.namespace, row.scope)));
      result.push(...docs.filter(Boolean).map((doc) => ({ ...doc.body, rev: doc.rev })));
    }
    return result;
  }
  async update(kind, id, fn, { expectedRev } = {}) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const current = await this.read(kind, id);
      if (expectedRev !== undefined && (current?.rev ?? 0) !== expectedRev) throw Object.assign(new Error("This item changed; reload before deciding"), { status: 409 });
      const body = await fn(current?.body ?? null);
      if (body === null) return { ...current?.body, rev: current?.rev ?? 0 };
      try {
        const saved = await this.client.putConfig(this.namespace(kind,id), "global", body, { ifMatchRev: current?.rev ?? 0 });
        return { ...body, rev: saved.rev };
      } catch (error) { if (error.status !== 409 || expectedRev !== undefined || attempt === 5) throw error; }
    }
  }
  async enqueue(proposal) { return this.update("proposal", proposal.id, (current) => current ? null : proposal); }
  async settings() {
    const doc = await this.read("settings", "global");
    return { memoryNode: "dev-madrid", maxProposals: 8, ...doc?.body,
      tracks: Object.fromEntries(Object.keys(TRACKS).map((id) => [id, { ...initialTrack(), ...doc?.body?.tracks?.[id] }])), rev: doc?.rev ?? 0 };
  }
  async updateTrack(track, fn) {
    if (!TRACKS[track]) throw new Error("Unknown improvement track");
    return this.update("settings", "global", (current) => ({ ...current,
      tracks: { ...current?.tracks, [track]: fn({ ...initialTrack(), ...current?.tracks?.[track] }) } }));
  }
}

// Node-local persistent state under $GARRISON_HOME/email-channel/ (outside the
// repo tree and outside apm_modules, so neither redeploys nor `apm install`
// touch it). The provisioned mailbox password is the root secret and is
// unrecoverable from mail.tm - account.json is written 0600 (the whatsapp-web
// session_dir precedent: self-generated connection state, not a vault key).

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const LEDGER_CAP = 200;

export class ChannelState {
  constructor(stateDir) {
    this.dir = stateDir;
    this.accountFile = path.join(stateDir, "account.json");
    this.ledgerFile = path.join(stateDir, "ledger.json");
  }

  async ensureDir() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
  }

  async loadAccount() {
    try {
      const acc = JSON.parse(await readFile(this.accountFile, "utf8"));
      return acc?.address && acc?.password ? acc : null;
    } catch {
      return null;
    }
  }

  async saveAccount(account) {
    await this.ensureDir();
    const tmp = `${this.accountFile}.tmp`;
    await writeFile(tmp, JSON.stringify(account, null, 2), { mode: 0o600 });
    await rename(tmp, this.accountFile);
  }

  // A dead account (mail.tm deleted it server-side) is moved aside, never
  // destroyed - the password is unrecoverable, so keep the record.
  async archiveAccount() {
    try {
      await rename(this.accountFile, `${this.accountFile}.dead-${Date.now()}`);
    } catch {}
  }

  async loadLedger() {
    try {
      const ledger = JSON.parse(await readFile(this.ledgerFile, "utf8"));
      return {
        ingested: Array.isArray(ledger?.ingested) ? ledger.ingested : [],
        rejected: Array.isArray(ledger?.rejected) ? ledger.rejected : [],
        counters: { polls: 0, ingested: 0, rejected: 0, ...(ledger?.counters ?? {}) }
      };
    } catch {
      return { ingested: [], rejected: [], counters: { polls: 0, ingested: 0, rejected: 0 } };
    }
  }

  async saveLedger(ledger) {
    await this.ensureDir();
    const capped = {
      ...ledger,
      ingested: ledger.ingested.slice(0, LEDGER_CAP),
      rejected: ledger.rejected.slice(0, LEDGER_CAP)
    };
    const tmp = `${this.ledgerFile}.tmp`;
    await writeFile(tmp, JSON.stringify(capped, null, 2), { mode: 0o600 });
    await rename(tmp, this.ledgerFile);
  }
}

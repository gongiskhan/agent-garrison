// garrison-accounts.ts — RUNTIME-ACCOUNTS-V1 CLI for the Anthropic account
// registry. The manual path next to the login UI: paste a `claude setup-token`
// token via STDIN (never argv — argv leaks into `ps`/shell history).
//
//   VAULT_UNLOCKED=true tsx scripts/garrison-accounts.ts list
//   claude setup-token | VAULT_UNLOCKED=true tsx scripts/garrison-accounts.ts add work1 --label "Work #1"
//   VAULT_UNLOCKED=true tsx scripts/garrison-accounts.ts remove work1
//
// Run under the SAME profile env as the instance that will use the account
// (GARRISON_HOME decides both the vault and the registry file; see
// scripts/garrison-instance.sh env).

import { addAccount, listAccounts, removeAccount } from "../src/lib/accounts";

function usage(): never {
  console.error("usage: tsx scripts/garrison-accounts.ts <list | add <name> [--label <label>] | remove <name>>");
  console.error("       `add` reads the token from STDIN (pipe or paste + Ctrl-D); token never in argv.");
  process.exit(2);
}

async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function main(): Promise<void> {
  const [command, name] = [process.argv[2], process.argv[3]];
  if (!command) usage();

  if (command === "list") {
    const accounts = await listAccounts();
    if (accounts.length === 0) {
      console.log("no accounts registered");
      return;
    }
    for (const account of accounts) {
      const age = account.ageDays === null ? "age unknown" : `${account.ageDays}d old`;
      const flags = account.needs_relogin ? " NEEDS-RELOGIN" : "";
      console.log(
        `${account.name.padEnd(20)} ${account.status.padEnd(13)} ${age}${account.label ? `  (${account.label})` : ""}${flags}`
      );
    }
    return;
  }

  if (command === "add") {
    if (!name) usage();
    const labelIdx = process.argv.indexOf("--label");
    const label = labelIdx > -1 ? process.argv[labelIdx + 1] : undefined;
    if (process.stdin.isTTY) {
      console.error(`paste the token for "${name}" and press Enter then Ctrl-D:`);
    }
    // The setup-token output may carry a trailing newline or surrounding
    // noise; the LAST sk-ant-… run in the input is the token.
    const raw = await readStdin();
    const match = raw.match(/sk-ant-[A-Za-z0-9_-]{8,}/g);
    const token = match ? match[match.length - 1] : raw.trim();
    const meta = await addAccount({ name, token, label });
    console.log(`account "${meta.name}" stored (token sealed in vault; metadata in registry)`);
    return;
  }

  if (command === "remove") {
    if (!name) usage();
    await removeAccount(name);
    console.log(`account "${name}" removed`);
    return;
  }

  usage();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

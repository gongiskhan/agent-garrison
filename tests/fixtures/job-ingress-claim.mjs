import { pathToFileURL } from "node:url";

const [modulePath, cardsDir, kind, maxPendingRaw] = process.argv.slice(2);
if (!modulePath || !cardsDir || !kind) process.exit(2);

const { createJobIngressGuard } = await import(pathToFileURL(modulePath).href);
const guard = createJobIngressGuard({ cardsDir, maxPending: Number(maxPendingRaw) || 1 });
const claim = await guard.claim({ kind });
process.stdout.write(`${JSON.stringify(claim)}\n`);

if (claim.accepted) {
  const timer = setInterval(() => {}, 60_000);
  const stop = () => {
    clearInterval(timer);
    process.exit(0);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

export const DISCONNECTED_COLOR = "#818782";

export function sessionDisconnected(row: { connection?: string; nodeStatus?: string; statusSource?: string }) {
  return row.connection === "disconnected" || row.statusSource === "stale-node" ||
    (!row.connection && row.nodeStatus === "offline");
}

export function sessionRunning(row: { status: string; connection?: string; nodeStatus?: string; statusSource?: string }) {
  return row.status === "working" && !sessionDisconnected(row);
}

export function disconnectedMessage(node: string) {
  return `Can't connect to ${node}. These are its last known sessions. Other machines are still available.`;
}

// Opening a conversation another node owns. Threads are home-node-owned
// (packages/talk/src/mesh-threads.mjs), so the target is a page on that node's
// origin; what changes is HOW this window gets there. In a browser it is a plain
// same-window navigation - never a new tab, the phone has nowhere to put one. In
// the Garrison app the webview is bound to one node, and a cross-origin
// navigation would be handed to Safari, so the app switches its node instead and
// carries the path across the switch (GarrisonNode.select's `path`). A peer the
// app does not know falls back to the navigation: reaching the conversation in
// Safari beats a tap that does nothing.
import { isNativeApp, nativeNode } from "@/lib/native-bridge";
import { sameNodeOrigin } from "@/lib/node-switch";

export async function openOnNode(url: string): Promise<void> {
  const target = new URL(url, window.location.href);
  if (target.origin !== window.location.origin && isNativeApp()) {
    const nodes = await nativeNode.list().catch(() => []);
    const record = nodes.find((n) => sameNodeOrigin(n.shellOrigin, target.hostname));
    if (record) {
      await nativeNode.select(record.name, `${target.pathname}${target.search}`);
      return;
    }
  }
  window.location.assign(target.href);
}

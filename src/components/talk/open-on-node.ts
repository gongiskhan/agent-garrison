// Opening a conversation another node owns. Threads are home-node-owned, and the
// rail's rows point at THIS node's /mesh/talk/<node>/<id> page
// (packages/talk/src/mesh-threads.mjs), which frames the conversation from its
// home node. So the target is a page on this origin and the open is a plain
// same-window navigation: never a new tab (a phone browser has nowhere to put
// one), never a cross-origin top-level load (the Garrison app hands those to
// Safari, a Home Screen install leaves its scope).
export function openOnNode(url: string): void {
  window.location.assign(new URL(url, window.location.href).href);
}

// The message a framed conversation posts to the window that frames it.
export const OPEN_CONVERSATION_MESSAGE = "garrison:open-conversation";

export interface OpenConversationMessage {
  type: typeof OPEN_CONVERSATION_MESSAGE;
  // Absolute, on the FRAMED node's origin: `/mesh/talk/<node>/<id>` there.
  url: string;
}

// Inside the frame the page belongs to the peer: its rail names pages on the
// peer's origin, and navigating the frame there would nest a second shell in
// the pane. The frame asks its parent to open the conversation instead; the
// parent maps the node onto its own routes (its own node becomes /talk/<id>).
// The url names a conversation, nothing secret, so any parent may hear it.
export function openViaParent(url: string): void {
  const target = new URL(url, window.location.href);
  const message: OpenConversationMessage = { type: OPEN_CONVERSATION_MESSAGE, url: target.href };
  window.parent.postMessage(message, "*");
}

// Where the parent lands for a conversation the frame asked for. `selfNode` is
// the parent's own node name; a request for it opens the local page. Null when
// the url is not a conversation route, so a stray message opens nothing.
export function parentRouteFor(url: string, selfNode: string | null): string | null {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  const remote = /^\/mesh\/talk\/([^/]+)(?:\/([^/]+))?\/?$/.exec(target.pathname);
  if (remote) {
    const node = decodeURIComponent(remote[1]);
    const id = remote[2] ? `/${remote[2]}` : "";
    if (selfNode && node === selfNode) return `/talk${id}${target.search}`;
    return `/mesh/talk/${encodeURIComponent(node)}${id}${target.search}`;
  }
  return null;
}

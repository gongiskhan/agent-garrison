import React from "react";

export function ZecaOriginChip({ origin, available }: { origin: { type: string; conversationId: string; messageIds?: string[] }; available?: boolean }) {
  if (available === false) return <span className="chip muted" title="Conversation no longer available">From Zeca (conversation no longer available)</span>;
  const params = { thread: origin.conversationId, ...(origin.messageIds?.length ? { message: origin.messageIds[0] } : {}) };
  const href = `/talk?${new URLSearchParams(params)}`;
  return <a className="chip" href={href} onClick={(event) => {
    if (window.parent === window) return;
    event.preventDefault(); window.parent.postMessage({ type: "garrison:navigate-route", route: "/talk", params }, "*");
  }}>From Zeca</a>;
}

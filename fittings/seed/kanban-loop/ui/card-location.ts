// ── Which card a URL points at ───────────────────────────────────────────────
//
// The board historically read only `?card=<id>`, but EVERY producer of a card
// link builds the hash shape `<base>/#/cards/<id>`: the gateway's "Card: ..."
// reply line, Slack outbound, the Omi push, the APNs notification, drill
// reports, and the MCP board tools. Nothing consumed that shape, so every card
// deep link ever sent opened the board and nothing else.
//
// Reading BOTH here revives the links already sitting in Slack history, in old
// push notifications and in stored conversation transcripts - places no
// producer-side change can reach.
//
// Pure and DOM-free: it takes the two location fields it needs, so it unit-tests
// without a browser or React.

/** The card id this location points at, or "" when it points at no card. */
export function cardIdFromLocation(location: { search?: string; hash?: string }): string {
  const query = new URLSearchParams(location.search || "");
  // An explicit query pin wins: it is the shape the board itself writes.
  const pinned = (query.get("card") || "").trim();
  if (pinned) return pinned;

  // `#/cards/<id>`, `#cards/<id>`, and a trailing `/` or query all mean the same
  // card - producers differ in punctuation and none of them should have to care.
  const hash = (location.hash || "").replace(/^#/, "");
  const match = /^\/?cards\/([^/?#]+)/.exec(hash);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]).trim();
  } catch {
    // A malformed escape is still a usable id; refusing it would lose the card.
    return match[1].trim();
  }
}

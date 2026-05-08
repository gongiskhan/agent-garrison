// Parse a message body string into a flat list of segments. The chat
// renderer consumes this to produce mixed plain-text / link nodes without
// pulling in a full markdown library — Garrison message bodies aren't
// markdown today, only opportunistic URLs.

export interface TextSegment {
  type: "text";
  value: string;
}

export interface GarrisonLinkSegment {
  type: "garrison";
  value: string;
  fittingId: string;
  rest: string;
}

export interface ExternalLinkSegment {
  type: "external";
  value: string;
  href: string;
}

export type MessageSegment =
  | TextSegment
  | GarrisonLinkSegment
  | ExternalLinkSegment;

const URL_PATTERN = /(garrison:\/\/[^\s<>"']+|https?:\/\/[^\s<>"']+)/g;
const GARRISON_PATTERN = /^garrison:\/\/([^/\s]+)(?:\/(.*))?$/;

export function parseMessageBody(text: string): MessageSegment[] {
  if (!text) {
    return [];
  }
  const segments: MessageSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      segments.push({ type: "text", value: text.slice(cursor, start) });
    }
    const url = match[0];
    const trimmed = stripTrailingPunctuation(url);
    if (trimmed.startsWith("garrison://")) {
      const parsed = GARRISON_PATTERN.exec(trimmed);
      if (parsed) {
        segments.push({
          type: "garrison",
          value: trimmed,
          fittingId: parsed[1],
          rest: parsed[2] ?? ""
        });
      } else {
        segments.push({ type: "text", value: trimmed });
      }
    } else {
      segments.push({ type: "external", value: trimmed, href: trimmed });
    }
    if (trimmed.length < url.length) {
      segments.push({ type: "text", value: url.slice(trimmed.length) });
    }
    cursor = start + url.length;
  }
  if (cursor < text.length) {
    segments.push({ type: "text", value: text.slice(cursor) });
  }
  return segments;
}

// Most URLs that appear in chat copy end with a sentence terminator that
// shouldn't belong to the URL. Strip a single trailing `.,;:!?)]}` so a
// reply like "see garrison://documents/abc." links the right thing.
function stripTrailingPunctuation(url: string): string {
  if (url.length === 0) return url;
  const last = url[url.length - 1];
  if (".,;:!?)]}".includes(last)) {
    return url.slice(0, -1);
  }
  return url;
}

export function garrisonRoutePath(fittingId: string, rest: string): string {
  if (!rest) {
    return `/fitting/${fittingId}`;
  }
  return `/fitting/${fittingId}/${rest}`;
}

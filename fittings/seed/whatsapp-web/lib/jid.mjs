// WhatsApp JID validation — the single choke point Rule 1 of the brief hangs
// off: send_text must only ever accept an exact, already-confirmed JID, never
// a bare name. An individual chat JID is "<digits>@s.whatsapp.net"; a group
// chat JID is "<digits>@g.us". Nothing else is a valid send target.
const JID_RE = /^\d+@(s\.whatsapp\.net|g\.us)$/;

export function isValidJid(value) {
  return typeof value === "string" && JID_RE.test(value);
}

export function assertValidJid(value, label = "to") {
  if (!isValidJid(value)) {
    throw new Error(
      `${label} must be an exact WhatsApp JID matching /^\\d+@(s.whatsapp.net|g.us)$/ (got ${JSON.stringify(
        value
      )}). Call resolve_contact first and use one of its candidates' jid — never guess or pass a bare name.`
    );
  }
}

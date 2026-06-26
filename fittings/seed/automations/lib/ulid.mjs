// Small monotonic-ish id generator for automations + runs (Crockford base32,
// time-prefixed so ids sort by creation). Not a full ULID spec — enough for
// stable, sortable, collision-resistant local ids.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(ms, len) {
  let out = "";
  for (let i = len - 1; i >= 0; i--) {
    const mod = ms % 32;
    out = ALPHABET[mod] + out;
    ms = Math.floor(ms / 32);
  }
  return out;
}

function randomChars(len) {
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[Math.floor(Math.random() * 32)];
  return out;
}

export function ulid(now = Date.now()) {
  return encodeTime(now, 10) + randomChars(16);
}

// Identifiers for every persisted row.
//
// They are lexicographically sortable, so an ordinary ORDER BY on the key
// column returns rows in creation order and no separate sequence column is
// needed. Random suffix, so two rows minted in the same millisecond still
// order deterministically and never collide.

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function randomSuffix(length) {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

/** A new sortable key. Use this for every row this service creates. */
export function mintKey(now = Date.now()) {
  return `${now.toString(36).padStart(9, "0")}${randomSuffix(10)}`;
}

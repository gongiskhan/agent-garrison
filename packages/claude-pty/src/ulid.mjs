// Minimal ULID — 48-bit timestamp + 80-bit randomness, Crockford base32 (26
// chars), lexicographically sortable by creation time. The brief wants ULID card
// ids so two simultaneous drops never race for an id and ids sort by time.
import { randomBytes } from "node:crypto";

const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32 (no I,L,O,U)

export function ulid(now = Date.now()) {
  let time = Math.floor(now);
  const timeChars = new Array(10);
  for (let i = 9; i >= 0; i--) {
    timeChars[i] = ENC[time % 32];
    time = Math.floor(time / 32);
  }
  const rand = randomBytes(16);
  let randStr = "";
  for (let i = 0; i < 16; i++) randStr += ENC[rand[i] % 32];
  return timeChars.join("") + randStr;
}

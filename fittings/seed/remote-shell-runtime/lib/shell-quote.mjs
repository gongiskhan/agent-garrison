// The one POSIX single-quote escape used everywhere a value crosses into a
// remote or local shell command string. Its own module so both sessions.mjs
// and runtimes.mjs can import it without importing each other.
export const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

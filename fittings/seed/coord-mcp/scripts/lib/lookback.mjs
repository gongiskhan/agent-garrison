// Lookback window for "recent" plans / intents / conflicts.
//
// Brief: 3 days on a weekday, 5 days on a Monday, 5-8 days on a weekend.
// Chosen deterministically within those bounds:
//   Tue–Fri (weekday) -> 3
//   Mon               -> 5   (longer: catches the weekend's work on restart)
//   Sat / Sun         -> 7   (squarely within the 5–8 weekend range)
export function lookbackDays(now = new Date()) {
  const d = now.getDay(); // 0=Sun .. 6=Sat
  if (d === 0 || d === 6) return 7; // weekend
  if (d === 1) return 5; // Monday
  return 3; // Tue–Fri
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function lookbackCutoff(now = new Date()) {
  return new Date(now.getTime() - lookbackDays(now) * DAY_MS);
}

export function withinLookback(ts, now = new Date()) {
  if (!ts) return false;
  const t = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(t.getTime())) return false;
  return t.getTime() >= lookbackCutoff(now).getTime();
}

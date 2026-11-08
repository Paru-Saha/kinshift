// All shift times are "floating" local times in the family's time zone, e.g. "2026-11-12T08:00:00".
// ISO strings in that form sort and compare correctly as plain strings.
export const TZ = process.env.FAMILY_TZ || 'America/New_York';

export function nowLocal() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

export const today = () => nowLocal().slice(0, 10);

const asUtc = (s) => new Date((s.length === 10 ? s + 'T00:00:00' : s) + 'Z');
const fmt = (d) => d.toISOString().slice(0, 19);

export function addDays(dateStr, n) {
  const d = asUtc(dateStr);
  d.setUTCDate(d.getUTCDate() + n);
  return dateStr.length === 10 ? fmt(d).slice(0, 10) : fmt(d);
}

export const dayOfWeek = (dateStr) => asUtc(dateStr.slice(0, 10)).getUTCDay(); // 0 = Sunday
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function mondayOf(dateStr) {
  const dow = dayOfWeek(dateStr);
  return addDays(dateStr.slice(0, 10), dow === 0 ? -6 : 1 - dow);
}

export const hoursBetween = (a, b) => (asUtc(b) - asUtc(a)) / 3_600_000;

export const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

export function at(dateStr, hhmm) {
  return `${dateStr}T${hhmm.length === 5 ? hhmm + ':00' : hhmm}`;
}

export function describe(start, end) {
  const d = start.slice(0, 10);
  return `${DAY_NAMES[dayOfWeek(d)]} ${d} ${start.slice(11, 16)}–${end.slice(11, 16)}`;
}

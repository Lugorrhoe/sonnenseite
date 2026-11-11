/** Everything in the app is shown in Munich local time, whatever the visitor's own time zone is. */

const TZ = 'Europe/Berlin';

const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});

export interface LocalParts { y: number; m: number; d: number; minutes: number }

export function berlinParts(date: Date): LocalParts {
  const p: Record<string, number> = {};
  for (const part of partsFmt.formatToParts(date)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return { y: p.year, m: p.month, d: p.day, minutes: p.hour * 60 + p.minute };
}

/** The instant at which Munich clocks show the given date and minutes after midnight. */
export function berlinToDate(y: number, m: number, d: number, minutes = 0): Date {
  const wanted = Date.UTC(y, m - 1, d, 0, minutes);
  let guess = wanted;
  for (let i = 0; i < 3; i++) {
    const p = berlinParts(new Date(guess));
    const shown = Date.UTC(p.y, p.m - 1, p.d, 0, p.minutes);
    const diff = wanted - shown;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

export function dayStart(date: Date): Date {
  const p = berlinParts(date);
  return berlinToDate(p.y, p.m, p.d, 0);
}

const pad = (n: number) => String(n).padStart(2, '0');

export function dateStr(date: Date): string {
  const p = berlinParts(date);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

export function parseDateStr(s: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
}

export function fmtMinutes(minutes: number): string {
  const mm = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(mm / 60))}:${pad(mm % 60)}`;
}

export function fmtTime(date: Date): string {
  return fmtMinutes(berlinParts(date).minutes);
}

export function fmtDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

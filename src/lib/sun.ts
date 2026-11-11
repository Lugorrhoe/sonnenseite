/** Sun position and everything derived from it: status now, day timeline, monthly sun hours. */
import * as SunCalc from 'suncalc';
import { MUC, XY } from './geo';
import { ShadowIndex } from './shadow';
import { berlinToDate } from './time';

export const NIGHT = 0;
export const SHADE = 1;
export const SUN = 2;
export type SunState = 0 | 1 | 2;

/** Below this elevation the sun is treated as set: light is weak and shadows are effectively endless. */
const MIN_ALTITUDE = (1 * Math.PI) / 180;

export interface SunPos {
  /** Radians clockwise from north. */
  bearing: number;
  /** Radians above the horizon. */
  altitude: number;
}

/** The sun's position differs by well under a tenth of a degree across Munich, so one position serves all. */
export function sunAt(date: Date): SunPos {
  const p = SunCalc.getPosition(date, MUC.lat, MUC.lng);
  // SunCalc 2 returns degrees: azimuth clockwise from north, altitude corrected for refraction.
  return { bearing: (p.azimuth * Math.PI) / 180, altitude: (p.altitude * Math.PI) / 180 };
}

export function isDaylight(pos: SunPos): boolean {
  return pos.altitude > MIN_ALTITUDE;
}

export function stateAt(index: ShadowIndex, p: XY, date: Date): SunState {
  const pos = sunAt(date);
  if (!isDaylight(pos)) return NIGHT;
  return index.isShaded(p, pos.bearing, pos.altitude) ? SHADE : SUN;
}

/** States for one Munich day, sampled every `step` minutes from local midnight. */
export function dayTimeline(index: ShadowIndex, p: XY, midnight: Date, step = 10): SunState[] {
  const out: SunState[] = [];
  for (let m = 0; m < 1440; m += step) {
    out.push(stateAt(index, p, new Date(midnight.getTime() + m * 60_000)));
  }
  return out;
}

export interface Window { from: number; to: number }

/** Contiguous sunny stretches, in minutes after midnight. */
export function sunWindows(states: SunState[], step = 10): Window[] {
  const out: Window[] = [];
  let start = -1;
  for (let i = 0; i <= states.length; i++) {
    const sunny = i < states.length && states[i] === SUN;
    if (sunny && start < 0) start = i;
    if (!sunny && start >= 0) {
      out.push({ from: start * step, to: i * step });
      start = -1;
    }
  }
  return out;
}

export function sunMinutes(states: SunState[], step = 10): number {
  return states.reduce<number>((n, s) => n + (s === SUN ? step : 0), 0);
}

export interface Outlook {
  state: SunState;
  /** If sunny: minutes of uninterrupted sun still to come. */
  sunLeft: number;
  /** If shaded: minutes until the sun reaches the spot today, or -1 if it will not. */
  sunIn: number;
}

/** Looks ahead from `from` until sunset in 10 minute steps. */
export function outlook(index: ShadowIndex, p: XY, from: Date, step = 10): Outlook {
  const state = stateAt(index, p, from);
  const res: Outlook = { state, sunLeft: 0, sunIn: -1 };
  if (state === NIGHT) return res;
  for (let m = step; m <= 17 * 60; m += step) {
    const s = stateAt(index, p, new Date(from.getTime() + m * 60_000));
    if (state === SUN) {
      if (s !== SUN) { res.sunLeft = m; return res; }
    } else {
      if (s === SUN) { res.sunIn = m; return res; }
      if (s === NIGHT) return res;
    }
  }
  if (state === SUN) res.sunLeft = 17 * 60;
  return res;
}

export interface MonthReport { month: number; sunHours: number; daylightHours: number }

/** Direct sun hours on the 15th of each month, assuming a cloudless sky. */
export function monthlyReport(index: ShadowIndex, p: XY, year: number, step = 15): MonthReport[] {
  const out: MonthReport[] = [];
  for (let month = 1; month <= 12; month++) {
    const states = dayTimeline(index, p, berlinToDate(year, month, 15), step);
    out.push({
      month,
      sunHours: sunMinutes(states, step) / 60,
      daylightHours: states.reduce<number>((n, s) => n + (s !== NIGHT ? step : 0), 0) / 60,
    });
  }
  return out;
}

export function sunriseSunset(date: Date): { sunrise: Date | null; sunset: Date | null } {
  const t = SunCalc.getTimes(date, MUC.lat, MUC.lng);
  return { sunrise: t.sunrise, sunset: t.sunset };
}

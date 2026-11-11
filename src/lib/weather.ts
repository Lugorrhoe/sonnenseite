/** Live weather and a seven day forecast from Open-Meteo (free, no key, CC BY 4.0). */
import { MUC } from './geo';

export interface Hour {
  /** Munich local time as "YYYY-MM-DDTHH:00". */
  time: string;
  temp: number;
  cloud: number;
  uv: number;
  wind: number;
  humidity: number;
  rain: number;
}

export interface Weather {
  fetchedAt: Date;
  current: { temp: number; feels: number; cloud: number; uv: number; wind: number; humidity: number };
  hours: Hour[];
  byTime: Map<string, Hour>;
}

const HOURLY = 'temperature_2m,cloud_cover,uv_index,wind_speed_10m,relative_humidity_2m,precipitation_probability';
const CURRENT = 'temperature_2m,apparent_temperature,cloud_cover,uv_index,wind_speed_10m,relative_humidity_2m';

export async function loadWeather(): Promise<Weather> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${MUC.lat}&longitude=${MUC.lng}` +
    `&current=${CURRENT}&hourly=${HOURLY}&forecast_days=7&timezone=Europe%2FBerlin`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
  const j = await r.json();
  const h = j.hourly;
  const num = (v: unknown) => (typeof v === 'number' ? v : NaN);
  const hours: Hour[] = (h.time as string[]).map((time, i) => ({
    time,
    temp: num(h.temperature_2m?.[i]),
    cloud: num(h.cloud_cover?.[i]),
    uv: num(h.uv_index?.[i]),
    wind: num(h.wind_speed_10m?.[i]),
    humidity: num(h.relative_humidity_2m?.[i]),
    rain: num(h.precipitation_probability?.[i]),
  }));
  const c = j.current ?? {};
  return {
    fetchedAt: new Date(),
    current: {
      temp: num(c.temperature_2m), feels: num(c.apparent_temperature), cloud: num(c.cloud_cover),
      uv: num(c.uv_index), wind: num(c.wind_speed_10m), humidity: num(c.relative_humidity_2m),
    },
    hours,
    byTime: new Map(hours.map((x) => [x.time, x])),
  };
}

/** Forecast for the hour containing the given Munich date string and minutes, if within range. */
export function hourAt(w: Weather | null, date: string, minutes: number): Hour | null {
  if (!w) return null;
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  return w.byTime.get(`${date}T${hh}:00`) ?? null;
}

export function skyLabel(cloud: number): string {
  if (!(cloud >= 0)) return '';
  if (cloud < 20) return 'Clear';
  if (cloud < 50) return 'Mostly sunny';
  if (cloud < 85) return 'Cloudy';
  return 'Overcast';
}

/** Above this cloud cover there is little direct sunshine, whatever the geometry says. */
export const OVERCAST = 85;

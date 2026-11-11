/**
 * Venues come from OpenStreetMap. A GitHub Action refreshes public/data/venues.json every night.
 * If that snapshot is missing or empty (for example on a fresh clone), the app asks Overpass directly.
 */
import { XY, toXY } from './geo';
import { OVERPASS_ENDPOINTS, buildQuery, normalize } from './overpass.js';

export type Category = 'cafe' | 'restaurant' | 'bar' | 'bakery' | 'biergarten' | 'playground' | 'sport' | 'golf';

export const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'cafe', label: 'Cafés' },
  { id: 'restaurant', label: 'Restaurants' },
  { id: 'bar', label: 'Bars' },
  { id: 'bakery', label: 'Bakeries' },
  { id: 'biergarten', label: 'Beer gardens' },
  { id: 'playground', label: 'Playgrounds' },
  { id: 'sport', label: 'Sports' },
  { id: 'golf', label: 'Golf' },
];

export interface Venue {
  id: string;
  name: string;
  cat: Category;
  lat: number;
  lng: number;
  hours?: string;
  web?: string;
  /** Raw position in metres. */
  xy: XY;
  /** Position used for the sun test once nearby buildings are known (moved out of the building). */
  spot?: XY;
}

export interface VenueData {
  venues: Venue[];
  generated: string | null;
  source: 'snapshot' | 'live';
}

type RawVenue = Omit<Venue, 'xy' | 'spot'>;

function hydrate(raw: RawVenue[]): Venue[] {
  return raw.map((v) => ({ ...v, xy: toXY(v.lng, v.lat) }));
}

async function fromOverpass(): Promise<RawVenue[]> {
  let lastError: unknown;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const r = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: buildQuery() }) });
      if (!r.ok) throw new Error(`Overpass ${r.status}`);
      const j = (await r.json()) as { elements: unknown[] };
      return normalize(j.elements) as RawVenue[];
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

export async function loadVenues(): Promise<VenueData> {
  try {
    const r = await fetch('data/venues.json', { cache: 'no-cache' });
    if (r.ok) {
      const j = (await r.json()) as { generated: string | null; venues: RawVenue[] };
      if (Array.isArray(j.venues) && j.venues.length > 0) {
        return { venues: hydrate(j.venues), generated: j.generated, source: 'snapshot' };
      }
    }
  } catch {
    /* fall through to the live query */
  }
  const raw = await fromOverpass();
  return { venues: hydrate(raw), generated: new Date().toISOString(), source: 'live' };
}

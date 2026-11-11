// Shared by the browser app and by scripts/fetch-venues.mjs (plain JS so Node can import it directly).

/** Munich area as Overpass expects it: south, west, north, east. */
export const OVERPASS_BBOX = '48.06,11.36,48.25,11.73';

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/**
 * Places where you can sit or play outside:
 * food and drink venues that OpenStreetMap contributors tagged with outdoor seating,
 * every beer garden, plus playgrounds, sports pitches and golf.
 */
export function buildQuery(bbox = OVERPASS_BBOX) {
  return `[out:json][timeout:180];
(
  nwr["amenity"~"^(cafe|restaurant|bar|pub|ice_cream|fast_food)$"]["outdoor_seating"]["outdoor_seating"!="no"](${bbox});
  nwr["amenity"="biergarten"](${bbox});
  nwr["shop"="bakery"]["outdoor_seating"]["outdoor_seating"!="no"](${bbox});
  nwr["leisure"~"^(playground|golf_course|miniature_golf)$"](${bbox});
  nwr["leisure"="pitch"]["sport"]["access"!="private"](${bbox});
);
out center tags;`;
}

/** @returns {string | null} */
export function categoryOf(tags) {
  const a = tags.amenity;
  if (a === 'biergarten') return 'biergarten';
  if (a === 'cafe' || a === 'ice_cream') return 'cafe';
  if (a === 'restaurant' || a === 'fast_food') return 'restaurant';
  if (a === 'bar' || a === 'pub') return 'bar';
  if (tags.shop === 'bakery') return 'bakery';
  const l = tags.leisure;
  if (l === 'playground') return 'playground';
  if (l === 'golf_course' || l === 'miniature_golf') return 'golf';
  if (l === 'pitch') return 'sport';
  return null;
}

const FALLBACK_NAMES = {
  playground: 'Playground',
  golf: 'Golf',
  sport: 'Sports pitch',
  biergarten: 'Beer garden',
};

/** Turns raw Overpass elements into the compact venue records the app uses. */
export function normalize(elements) {
  const out = [];
  const seen = new Set();
  for (const el of elements) {
    const tags = el.tags || {};
    const cat = categoryOf(tags);
    if (!cat) continue;
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    const id = `${el.type[0]}${el.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    let name = tags.name;
    if (!name) {
      if (!FALLBACK_NAMES[cat]) continue; // an unnamed cafe is not much use in a ranking
      name = cat === 'sport' && tags.sport ? `${FALLBACK_NAMES.sport} (${String(tags.sport).split(';')[0]})` : FALLBACK_NAMES[cat];
    }
    const v = { id, name: String(name).slice(0, 80), cat, lat: +lat.toFixed(6), lng: +lng.toFixed(6) };
    if (tags.opening_hours) v.hours = String(tags.opening_hours).slice(0, 120);
    const site = tags.website || tags['contact:website'];
    if (site && /^https?:\/\//i.test(site)) v.web = String(site).slice(0, 200);
    out.push(v);
  }
  out.sort((a, b) => (a.id < b.id ? -1 : 1));
  return out;
}

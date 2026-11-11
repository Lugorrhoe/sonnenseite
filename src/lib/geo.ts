/** Planar geometry helpers. All coordinates are metres in a local frame centred on Munich. */

export type XY = [number, number];

/** Projection origin: Marienplatz. The Munich area is small enough for an equirectangular frame. */
export const MUC = { lat: 48.1372, lng: 11.5755 };

/** Area the app covers: [west, south, east, north]. */
export const MUC_BBOX: [number, number, number, number] = [11.36, 48.06, 11.73, 48.25];

// Length of one degree on the WGS84 ellipsoid at Munich's latitude (standard series expansion).
const PHI = (MUC.lat * Math.PI) / 180;
const M_PER_DEG_LAT = 111_132.954 - 559.822 * Math.cos(2 * PHI) + 1.175 * Math.cos(4 * PHI);
const M_PER_DEG_LNG = 111_412.84 * Math.cos(PHI) - 93.5 * Math.cos(3 * PHI) + 0.118 * Math.cos(5 * PHI);

export function toXY(lng: number, lat: number): XY {
  return [(lng - MUC.lng) * M_PER_DEG_LNG, (lat - MUC.lat) * M_PER_DEG_LAT];
}

export function toLngLat(x: number, y: number): [number, number] {
  return [MUC.lng + x / M_PER_DEG_LNG, MUC.lat + y / M_PER_DEG_LAT];
}

/** Even-odd point in polygon test across all rings, so holes (courtyards) count as outside. */
export function pointInRings(px: number, py: number, rings: XY[][]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/**
 * Distance t along a ray (origin p, unit direction d) to segment a-b, or -1 if they do not meet.
 */
export function raySegment(
  px: number, py: number, dx: number, dy: number,
  ax: number, ay: number, bx: number, by: number,
): number {
  const ex = bx - ax;
  const ey = by - ay;
  const den = dx * ey - dy * ex;
  if (Math.abs(den) < 1e-12) return -1;
  const t = ((ax - px) * ey - (ay - py) * ex) / den;
  if (t < 0) return -1;
  const u = ((ax - px) * dy - (ay - py) * dx) / den;
  if (u < 0 || u > 1) return -1;
  return t;
}

/** Closest point to p on segment a-b. */
export function closestOnSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): XY {
  const ex = bx - ax;
  const ey = by - ay;
  const len2 = ex * ex + ey * ey;
  if (len2 === 0) return [ax, ay];
  const u = Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / len2));
  return [ax + u * ex, ay + u * ey];
}

export function dist(a: XY, b: XY): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

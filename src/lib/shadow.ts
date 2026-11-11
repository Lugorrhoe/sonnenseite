/**
 * Shadow engine.
 *
 * Buildings are extruded footprints (rings in metres, a top height and an optional base height).
 * A spot is shaded when a ray from the spot towards the sun hits a building below the building's top.
 * A uniform grid keeps the ray test to the handful of buildings the ray actually passes.
 */
import { XY, closestOnSegment, pointInRings, raySegment } from './geo';

export interface Building {
  id: number;
  /** Outer ring first, then holes. Rings are open (first point is not repeated). */
  rings: XY[][];
  h: number;
  minH: number;
  minX: number; minY: number; maxX: number; maxY: number;
  stamp: number;
}

const CELL = 64; // metres
/** Longest shadow we follow. At very low sun the true shadow is longer but also very faint. */
export const MAX_REACH = 400;
/** Height above ground at which a seated person's upper body is. */
export const EYE_HEIGHT = 1.2;

const key = (cx: number, cy: number) => cx * 73856093 ^ cy * 19349663;

export class ShadowIndex {
  private cells = new Map<number, Building[]>();
  private nextId = 1;
  private queryStamp = 0;
  maxH = 0;
  count = 0;

  add(rings: XY[][], h: number, minH = 0): void {
    const outer = rings[0];
    if (!outer || outer.length < 3 || !(h > 0)) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of outer) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const b: Building = { id: this.nextId++, rings, h, minH, minX, minY, maxX, maxY, stamp: 0 };
    const cx0 = Math.floor(minX / CELL), cx1 = Math.floor(maxX / CELL);
    const cy0 = Math.floor(minY / CELL), cy1 = Math.floor(maxY / CELL);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const k = key(cx, cy);
        const list = this.cells.get(k);
        if (list) list.push(b);
        else this.cells.set(k, [b]);
      }
    }
    if (h > this.maxH) this.maxH = h;
    this.count++;
  }

  /** All buildings whose bounding box touches the given box. */
  query(minX: number, minY: number, maxX: number, maxY: number): Building[] {
    const stamp = ++this.queryStamp;
    const out: Building[] = [];
    for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) {
      for (let cy = Math.floor(minY / CELL); cy <= Math.floor(maxY / CELL); cy++) {
        const list = this.cells.get(key(cx, cy));
        if (!list) continue;
        for (const b of list) {
          if (b.stamp === stamp) continue;
          b.stamp = stamp;
          if (b.maxX < minX || b.minX > maxX || b.maxY < minY || b.minY > maxY) continue;
          out.push(b);
        }
      }
    }
    return out;
  }

  /** The building whose footprint contains the point, if any. */
  buildingAt(p: XY): Building | null {
    for (const b of this.query(p[0], p[1], p[0], p[1])) {
      if (pointInRings(p[0], p[1], b.rings)) return b;
    }
    return null;
  }

  /**
   * Is the spot in shadow?
   * @param bearing direction of the sun, radians clockwise from north
   * @param altitude elevation of the sun above the horizon, radians (must be > 0)
   */
  isShaded(p: XY, bearing: number, altitude: number, eye = EYE_HEIGHT): boolean {
    const tanA = Math.tan(altitude);
    if (!(tanA > 0)) return true;
    const reach = Math.min(MAX_REACH, (this.maxH - eye) / tanA);
    if (reach <= 0) return false;
    const dx = Math.sin(bearing);
    const dy = Math.cos(bearing);
    const [px, py] = p;
    const stamp = ++this.queryStamp;
    const step = CELL / 4;
    let lastKey = NaN;
    for (let s = 0; s <= reach + step; s += step) {
      const k = key(Math.floor((px + dx * s) / CELL), Math.floor((py + dy * s) / CELL));
      if (k === lastKey) continue;
      lastKey = k;
      const list = this.cells.get(k);
      if (!list) continue;
      for (const b of list) {
        if (b.stamp === stamp) continue;
        b.stamp = stamp;
        if (b.h <= eye) continue;
        if (blocks(b, px, py, dx, dy, tanA, eye, reach)) return true;
      }
    }
    return false;
  }

  /**
   * If the point lies inside a building footprint, move it just outside the nearest wall.
   * OpenStreetMap usually maps a venue as a point inside its building, while the terrace is in front.
   */
  pushOutside(p: XY, clearance = 2.5): XY {
    const b = this.buildingAt(p);
    if (!b) return p;
    let best: XY | null = null;
    let bestD = Infinity;
    for (const ring of b.rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const c = closestOnSegment(p[0], p[1], ring[j][0], ring[j][1], ring[i][0], ring[i][1]);
        const d = Math.hypot(c[0] - p[0], c[1] - p[1]);
        if (d < bestD) { bestD = d; best = c; }
      }
    }
    if (!best || bestD < 1e-6) return p;
    const ux = (best[0] - p[0]) / bestD;
    const uy = (best[1] - p[1]) / bestD;
    for (const c of [clearance, 1, 0.3]) {
      const q: XY = [best[0] + ux * c, best[1] + uy * c];
      if (!this.buildingAt(q)) return q;
    }
    return p;
  }
}

function blocks(
  b: Building, px: number, py: number, dx: number, dy: number,
  tanA: number, eye: number, reach: number,
): boolean {
  // A spot inside a footprint (for example under a mapped roof) is not shaded by that same footprint.
  if (px >= b.minX && px <= b.maxX && py >= b.minY && py <= b.maxY && pointInRings(px, py, b.rings)) return false;
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const ring of b.rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const t = raySegment(px, py, dx, dy, ring[j][0], ring[j][1], ring[i][0], ring[i][1]);
      if (t < 0) continue;
      if (t < tMin) tMin = t;
      if (t > tMax) tMax = t;
    }
  }
  if (tMin > reach) return false;
  // The ray is lowest where it enters the footprint and highest where it leaves.
  const rayIn = eye + tMin * tanA;
  const rayOut = eye + tMax * tanA;
  return b.h > rayIn && b.minH < rayOut;
}

/**
 * Ground shadow of one building as a list of polygons (each a list of rings).
 * The sweep of a footprint along the shadow vector equals the shifted footprint
 * plus one quad per wall, so no polygon union is needed.
 */
export function shadowPolygons(b: Building, bearing: number, altitude: number): XY[][][] {
  const tanA = Math.tan(altitude);
  if (!(tanA > 0)) return [];
  const len = Math.min(MAX_REACH, b.h / tanA);
  const ox = -Math.sin(bearing) * len;
  const oy = -Math.cos(bearing) * len;
  const polys: XY[][][] = [];
  polys.push(b.rings.map((ring) => ring.map(([x, y]) => [x + ox, y + oy] as XY)));
  for (const ring of b.rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j];
      const c = ring[i];
      if (Math.abs(a[0] - c[0]) + Math.abs(a[1] - c[1]) < 0.3) continue;
      polys.push([[a, c, [c[0] + ox, c[1] + oy], [a[0] + ox, a[1] + oy]]]);
    }
  }
  return polys;
}

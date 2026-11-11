/**
 * Loads building footprints and heights from OpenFreeMap vector tiles (OpenStreetMap data,
 * rebuilt by OpenFreeMap on a regular schedule) and feeds them into the shadow index.
 * These are the same tiles the base map uses, so the browser cache serves both.
 */
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { XY, toLngLat, toXY } from './geo';
import { ShadowIndex } from './shadow';

const TILEJSON = 'https://tiles.openfreemap.org/planet';
const Z = 14; // highest zoom OpenFreeMap serves; contains every building
const DEFAULT_HEIGHT = 6;

function lngToTile(lng: number): number {
  return Math.floor(((lng + 180) / 360) * 2 ** Z);
}
function latToTile(lat: number): number {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** Z);
}

type Ring = number[][];

/** Converts GeoJSON polygon rings (lng/lat, closed) into open rings in metres. */
export function ringsToXY(rings: Ring[]): XY[][] {
  return rings
    .map((ring) => {
      const pts = ring.map(([lng, lat]) => toXY(lng, lat));
      if (pts.length > 1) {
        const a = pts[0];
        const b = pts[pts.length - 1];
        if (a[0] === b[0] && a[1] === b[1]) pts.pop();
      }
      return pts;
    })
    .filter((r) => r.length >= 3);
}

/** Adds every building in a decoded tile to the index. Returns how many were added. */
export function addTileBuildings(index: ShadowIndex, tile: VectorTile, x: number, y: number): number {
  const layer = tile.layers.building;
  if (!layer) return 0;
  let n = 0;
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    if (f.type !== 3) continue;
    const props = f.properties as Record<string, unknown>;
    // Outlines of buildings that are also mapped as detailed parts; the parts carry the real heights.
    if (props.hide_3d === true) continue;
    const h = Number(props.render_height) > 0 ? Number(props.render_height) : DEFAULT_HEIGHT;
    const minH = Number(props.render_min_height) > 0 ? Number(props.render_min_height) : 0;
    const g = f.toGeoJSON(x, y, Z).geometry;
    const polys: Ring[][] =
      g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const poly of polys) {
      const rings = ringsToXY(poly);
      if (rings.length) { index.add(rings, h, minH); n++; }
    }
  }
  return n;
}

export class BuildingStore {
  readonly index = new ShadowIndex();
  private tiles = new Map<string, Promise<void>>();
  private done = new Set<string>();
  private template: Promise<string> | null = null;
  failed = 0;

  private tileUrl(): Promise<string> {
    if (!this.template) {
      this.template = fetch(TILEJSON)
        .then((r) => {
          if (!r.ok) throw new Error(`TileJSON ${r.status}`);
          return r.json();
        })
        .then((j: { tiles: string[] }) => j.tiles[0])
        .catch((e) => { this.template = null; throw e; });
    }
    return this.template;
  }

  private load(x: number, y: number): Promise<void> {
    const k = `${x}/${y}`;
    let p = this.tiles.get(k);
    if (!p) {
      p = this.tileUrl()
        .then((t) => fetch(t.replace('{z}', String(Z)).replace('{x}', String(x)).replace('{y}', String(y))))
        .then((r) => {
          if (!r.ok) throw new Error(`tile ${k}: ${r.status}`);
          return r.arrayBuffer();
        })
        .then((buf) => {
          addTileBuildings(this.index, new VectorTile(new PbfReader(new Uint8Array(buf))), x, y);
          this.done.add(k);
        })
        .catch((e) => {
          this.failed++;
          this.tiles.delete(k); // allow a retry later
          console.warn('Building tile failed', e);
        });
      this.tiles.set(k, p);
    }
    return p;
  }

  private range(w: number, s: number, e: number, n: number) {
    return { x0: lngToTile(w), x1: lngToTile(e), y0: latToTile(n), y1: latToTile(s) };
  }

  /** True when every tile touching the box is loaded. Box is in degrees. */
  ready(w: number, s: number, e: number, n: number): boolean {
    const r = this.range(w, s, e, n);
    for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) if (!this.done.has(`${x}/${y}`)) return false;
    return true;
  }

  ensure(w: number, s: number, e: number, n: number): Promise<void> {
    const r = this.range(w, s, e, n);
    const jobs: Promise<void>[] = [];
    if ((r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1) > 80) return Promise.resolve(); // far too zoomed out
    for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) jobs.push(this.load(x, y));
    return Promise.all(jobs).then(() => undefined);
  }

  /** Box in degrees around a point in metres, padded so shadows from outside the view are included. */
  static boxAround(p: XY, radius: number): [number, number, number, number] {
    const [w, s] = toLngLat(p[0] - radius, p[1] - radius);
    const [e, n] = toLngLat(p[0] + radius, p[1] + radius);
    return [w, s, e, n];
  }

  readyAround(p: XY, radius: number): boolean {
    return this.ready(...BuildingStore.boxAround(p, radius));
  }

  ensureAround(p: XY, radius: number): Promise<void> {
    return this.ensure(...BuildingStore.boxAround(p, radius));
  }
}

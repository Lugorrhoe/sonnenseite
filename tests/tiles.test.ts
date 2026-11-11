import { describe, expect, it } from 'vitest';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader, PbfWriter } from 'pbf';
import { addTileBuildings } from '../src/lib/buildings';
import { MUC, toXY } from '../src/lib/geo';
import { ShadowIndex } from '../src/lib/shadow';

// The sandbox this project was built in cannot download real tiles, so this test encodes a small
// Mapbox Vector Tile by hand (per the MVT 2.1 spec) and runs it through the same decoding path the app uses.

const Z = 14;
const tileX = Math.floor(((MUC.lng + 180) / 360) * 2 ** Z);
const latRad = (MUC.lat * Math.PI) / 180;
const tileY = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * 2 ** Z);

const zz = (n: number) => (n << 1) ^ (n >> 31);

interface Feat { square: [number, number, number]; props: Record<string, number | boolean> }

function encodeTile(features: Feat[]): Uint8Array {
  const keys: string[] = [];
  const values: (number | boolean)[] = [];
  const pbf = new PbfWriter();
  pbf.writeMessage(3, (_: unknown, layer: PbfWriter) => {
    layer.writeVarintField(15, 2);
    layer.writeStringField(1, 'building');
    for (const f of features) {
      const tags: number[] = [];
      for (const [k, v] of Object.entries(f.props)) {
        if (!keys.includes(k)) keys.push(k);
        values.push(v);
        tags.push(keys.indexOf(k), values.length - 1);
      }
      const [x, y, size] = f.square;
      // MoveTo, three LineTo, ClosePath: a clockwise square in tile coordinates (y points down).
      const geom = [9, zz(x), zz(y), 26, zz(size), zz(0), zz(0), zz(size), zz(-size), zz(0), 15];
      layer.writeMessage(2, (_f: unknown, feat: PbfWriter) => {
        feat.writePackedVarint(2, tags);
        feat.writeVarintField(3, 3);
        feat.writePackedVarint(4, geom);
      }, null);
    }
    for (const k of keys) layer.writeStringField(3, k);
    for (const v of values) {
      layer.writeMessage(4, (_v: unknown, val: PbfWriter) => {
        if (typeof v === 'boolean') val.writeBooleanField(7, v);
        else val.writeDoubleField(3, v);
      }, null);
    }
    layer.writeVarintField(5, 4096);
  }, null);
  return pbf.finish();
}

describe('building tiles', () => {
  it('decodes footprints and heights into the shadow index at the right place and scale', () => {
    const bytes = encodeTile([
      { square: [1000, 1000, 100], props: { render_height: 22, render_min_height: 0 } },
      { square: [3000, 3000, 50], props: {} },
      { square: [2000, 2000, 80], props: { render_height: 40, hide_3d: true } },
    ]);
    const index = new ShadowIndex();
    const added = addTileBuildings(index, new VectorTile(new PbfReader(bytes)), tileX, tileY);
    expect(added).toBe(2); // the hide_3d outline is skipped
    expect(index.maxH).toBe(22);

    // Where tile coordinates land on the ground, by the exact Web Mercator formulas.
    const n = 2 ** Z;
    const ground = (px: number, py: number) => {
      const lng = ((tileX + px / 4096) / n) * 360 - 180;
      const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (tileY + py / 4096)) / n))) * 180) / Math.PI;
      return toXY(lng, lat);
    };
    const [west, north] = ground(1000, 1000);
    const [east, south] = ground(1100, 1100);

    const [cx, cy] = ground(2048, 2048);
    const all = index.query(cx - 1500, cy - 1500, cx + 1500, cy + 1500);
    expect(all.length).toBe(2);
    const tall = all.find((b) => b.h === 22)!;
    expect(tall.rings[0].length).toBe(4);
    expect(tall.minX).toBeCloseTo(west, 2);
    expect(tall.maxX).toBeCloseTo(east, 2);
    expect(tall.maxY).toBeCloseTo(north, 2);
    expect(tall.minY).toBeCloseTo(south, 2);
    // 100 tile units at zoom 14 in Munich are about 40 m on the ground.
    expect(tall.maxX - tall.minX).toBeGreaterThan(39);
    expect(tall.maxX - tall.minX).toBeLessThan(41);
    expect(tall.maxY - tall.minY).toBeGreaterThan(39);
    expect(tall.maxY - tall.minY).toBeLessThan(41);

    const fallback = all.find((b) => b !== tall)!;
    expect(fallback.h).toBe(6); // no height in the data: assume two storeys

    // End to end: a spot just north of the 22 m building is shaded by a low southern sun.
    const spot: [number, number] = [(tall.minX + tall.maxX) / 2, tall.maxY + 10];
    expect(index.isShaded(spot, Math.PI, (25 * Math.PI) / 180)).toBe(true);
    expect(index.isShaded(spot, 0, (25 * Math.PI) / 180)).toBe(false);
  });
});

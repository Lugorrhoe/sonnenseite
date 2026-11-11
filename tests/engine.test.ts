import { describe, expect, it } from 'vitest';
import { XY, pointInRings, raySegment, toLngLat, toXY } from '../src/lib/geo';
import { ShadowIndex, shadowPolygons } from '../src/lib/shadow';
import { NIGHT, SHADE, SUN, dayTimeline, monthlyReport, outlook, stateAt, sunAt, sunMinutes, sunWindows } from '../src/lib/sun';
import { berlinParts, berlinToDate, dateStr, fmtDuration, fmtMinutes } from '../src/lib/time';
import { categoryOf, normalize } from '../src/lib/overpass.js';

const deg = (d: number) => (d * Math.PI) / 180;
const box = (x0: number, y0: number, x1: number, y1: number): XY[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

describe('geometry', () => {
  it('round trips coordinates', () => {
    const [x, y] = toXY(11.6, 48.2);
    const [lng, lat] = toLngLat(x, y);
    expect(lng).toBeCloseTo(11.6, 9);
    expect(lat).toBeCloseTo(48.2, 9);
  });

  it('measures real distances', () => {
    // One arc minute of latitude is one nautical mile, to within a tenth of a percent at this latitude.
    const [, y] = toXY(11.5755, 48.1372 + 1 / 60);
    expect(Math.abs(y - 1852) / 1852).toBeLessThan(0.002);
    // One degree of longitude at 48.1372 N on the WGS84 ellipsoid is 74.43 km.
    const [x] = toXY(12.5755, 48.1372);
    expect(x / 1000).toBeCloseTo(74.43, 1);
  });

  it('treats holes as outside', () => {
    const rings = [box(0, 0, 30, 30), box(10, 10, 20, 20)];
    expect(pointInRings(5, 5, rings)).toBe(true);
    expect(pointInRings(15, 15, rings)).toBe(false);
    expect(pointInRings(40, 5, rings)).toBe(false);
  });

  it('intersects rays with segments', () => {
    expect(raySegment(0, 0, 0, 1, -5, 10, 5, 10)).toBeCloseTo(10);
    expect(raySegment(0, 0, 0, -1, -5, 10, 5, 10)).toBe(-1);
    expect(raySegment(0, 0, 0, 1, 1, 10, 5, 10)).toBe(-1);
  });
});

describe('shadow engine', () => {
  // A 20 m tall block directly south of the origin, its north wall at y = -10.
  const index = new ShadowIndex();
  index.add([box(-15, -30, 15, -10)], 20);
  const south = deg(180);

  it('matches the analytic shadow length', () => {
    // Sun due south at 30 degrees: the wall top shades (20 - 1.2) / tan(30) = 32.56 m beyond the wall.
    const reach = (20 - 1.2) / Math.tan(deg(30));
    expect(index.isShaded([0, -10 + reach - 0.5], south, deg(30))).toBe(true);
    expect(index.isShaded([0, -10 + reach + 0.5], south, deg(30))).toBe(false);
  });

  it('is sunny when the sun is on the open side', () => {
    expect(index.isShaded([0, 0], deg(0), deg(30))).toBe(false);
    expect(index.isShaded([0, 0], deg(90), deg(30))).toBe(false);
  });

  it('is sunny beside the building', () => {
    expect(index.isShaded([40, 0], south, deg(30))).toBe(false);
  });

  it('agrees with a brute force oracle on random spots and sun positions', () => {
    const idx = new ShadowIndex();
    const blocks: { x0: number; y0: number; x1: number; y1: number; h: number }[] = [];
    let seed = 42;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let i = 0; i < 60; i++) {
      const x0 = rnd() * 600 - 300, y0 = rnd() * 600 - 300;
      const b = { x0, y0, x1: x0 + 8 + rnd() * 30, y1: y0 + 8 + rnd() * 30, h: 4 + rnd() * 40 };
      blocks.push(b);
      idx.add([box(b.x0, b.y0, b.x1, b.y1)], b.h);
    }
    // Oracle: march along the ray in 5 cm steps and compare ray height to roof height.
    const oracle = (p: XY, bearing: number, alt: number) => {
      const dx = Math.sin(bearing), dy = Math.cos(bearing), tanA = Math.tan(alt);
      const inside = (x: number, y: number) => blocks.filter((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1);
      const own = new Set(inside(p[0], p[1]));
      for (let t = 0; t <= 400; t += 0.05) {
        for (const b of inside(p[0] + dx * t, p[1] + dy * t)) {
          if (!own.has(b) && b.h > 1.2 + t * tanA) return true;
        }
      }
      return false;
    };
    let disagreements = 0;
    let shaded = 0;
    for (let i = 0; i < 400; i++) {
      const p: XY = [rnd() * 500 - 250, rnd() * 500 - 250];
      const bearing = rnd() * Math.PI * 2;
      const alt = deg(5 + rnd() * 55);
      const a = idx.isShaded(p, bearing, alt);
      if (a) shaded++;
      if (a !== oracle(p, bearing, alt)) disagreements++;
    }
    expect(shaded).toBeGreaterThan(40); // the scene really does produce both outcomes
    expect(shaded).toBeLessThan(360);
    // Grazing rays within 5 cm of a corner may differ between the exact test and the stepped oracle.
    expect(disagreements).toBeLessThanOrEqual(4);
  });

  it('lets light through a courtyard', () => {
    const idx = new ShadowIndex();
    idx.add([box(0, 0, 60, 60), box(10, 10, 50, 50)], 15);
    // High sun: the middle of a 40 m courtyard is lit. Low sun: it is not.
    expect(idx.isShaded([30, 30], south, deg(60))).toBe(false);
    expect(idx.isShaded([30, 30], south, deg(20))).toBe(true);
  });

  it('respects elevated building parts', () => {
    const idx = new ShadowIndex();
    idx.add([box(-5, -20, 5, -10)], 30, 25); // a slab floating between 25 and 30 m
    expect(idx.isShaded([0, 0], south, deg(20))).toBe(false); // the ray passes underneath
    expect(idx.isShaded([0, 0], south, deg(62))).toBe(true); // the ray hits the slab
  });

  it('moves a venue mapped inside its building to just outside the nearest wall', () => {
    const p = index.pushOutside([0, -12]);
    expect(p[0]).toBeCloseTo(0);
    expect(p[1]).toBeCloseTo(-7.5);
    expect(index.pushOutside([100, 100])).toEqual([100, 100]);
  });

  it('builds ground shadow polygons that cover exactly the shaded ground', () => {
    const b = index.query(-15, -30, 15, -10)[0];
    const polys = shadowPolygons(b, south, deg(30));
    const len = 20 / Math.tan(deg(30));
    const covered = (x: number, y: number) => polys.some((rings) => pointInRings(x, y, rings));
    expect(covered(0, -10 + len - 0.5)).toBe(true);
    expect(covered(0, -10 + len + 0.5)).toBe(false);
    expect(covered(20, 0)).toBe(false);
  });
});

describe('sun', () => {
  it('puts the midsummer noon sun high in the south over Munich', () => {
    const pos = sunAt(new Date('2026-06-21T11:16:00Z')); // about solar noon
    expect((pos.bearing * 180) / Math.PI).toBeGreaterThan(175);
    expect((pos.bearing * 180) / Math.PI).toBeLessThan(185);
    expect((pos.altitude * 180) / Math.PI).toBeCloseTo(90 - 48.137 + 23.44, 0);
  });

  it('puts the evening sun in the west and the midnight sun below the horizon', () => {
    const evening = sunAt(new Date('2026-06-21T17:30:00Z'));
    expect((evening.bearing * 180) / Math.PI).toBeGreaterThan(260);
    expect(sunAt(new Date('2026-06-21T23:00:00Z')).altitude).toBeLessThan(0);
  });

  it('produces a plausible day for an open field and for a spot north of a wall', () => {
    const empty = new ShadowIndex();
    const midsummer = berlinToDate(2026, 6, 21);
    const open = dayTimeline(empty, [0, 0], midsummer);
    expect(open.length).toBe(144);
    expect(open[0]).toBe(NIGHT);
    expect(open[72]).toBe(SUN);
    expect(sunMinutes(open) / 60).toBeGreaterThan(15);
    expect(sunMinutes(open) / 60).toBeLessThan(16.5);
    expect(sunWindows(open).length).toBe(1);

    const wall = new ShadowIndex();
    wall.add([box(-200, -30, 200, -10)], 25);
    // 20 m north of a 25 m wall: shaded by the low winter sun, clear of the high summer sun.
    const spot: XY = [0, 10];
    expect(stateAt(wall, spot, berlinToDate(2026, 12, 21, 12 * 60 + 15))).toBe(SHADE);
    expect(stateAt(wall, spot, berlinToDate(2026, 6, 21, 13 * 60 + 15))).toBe(SUN);
    const report = monthlyReport(wall, spot, 2026);
    expect(report.length).toBe(12);
    expect(report[11].sunHours).toBe(0); // December: the low sun never clears the wall
    expect(report[5].sunHours).toBeGreaterThan(8);
  });

  it('looks ahead to when the sun leaves or arrives', () => {
    const wall = new ShadowIndex();
    wall.add([box(10, -200, 30, 200)], 25); // a long wall to the east
    const morning = outlook(wall, [0, 0], berlinToDate(2026, 6, 21, 7 * 60));
    expect(morning.state).toBe(SHADE);
    expect(morning.sunIn).toBeGreaterThan(0);
    const noon = outlook(wall, [0, 0], berlinToDate(2026, 6, 21, 14 * 60));
    expect(noon.state).toBe(SUN);
    expect(noon.sunLeft).toBeGreaterThan(5 * 60);
  });
});

describe('time', () => {
  it('converts Munich wall clock time in summer and winter', () => {
    expect(berlinToDate(2026, 7, 1, 12 * 60).toISOString()).toBe('2026-07-01T10:00:00.000Z');
    expect(berlinToDate(2026, 1, 15, 12 * 60).toISOString()).toBe('2026-01-15T11:00:00.000Z');
    expect(berlinParts(new Date('2026-07-01T22:30:00Z'))).toEqual({ y: 2026, m: 7, d: 2, minutes: 30 });
    expect(dateStr(new Date('2026-12-31T23:30:00Z'))).toBe('2027-01-01');
  });

  it('formats', () => {
    expect(fmtMinutes(9 * 60 + 5)).toBe('09:05');
    expect(fmtDuration(135)).toBe('2 h 15 min');
    expect(fmtDuration(40)).toBe('40 min');
  });
});

describe('OpenStreetMap normalisation', () => {
  it('maps tags to categories', () => {
    expect(categoryOf({ amenity: 'cafe' })).toBe('cafe');
    expect(categoryOf({ amenity: 'pub' })).toBe('bar');
    expect(categoryOf({ shop: 'bakery' })).toBe('bakery');
    expect(categoryOf({ leisure: 'pitch' })).toBe('sport');
    expect(categoryOf({ amenity: 'bank' })).toBe(null);
  });

  it('normalises nodes and ways, drops unnamed cafes and unsafe links', () => {
    const venues: any[] = normalize([
      { type: 'node', id: 1, lat: 48.1371234567, lon: 11.5751234567, tags: { amenity: 'cafe', name: 'Café Sonne', website: 'javascript:alert(1)' } },
      { type: 'way', id: 2, center: { lat: 48.14, lon: 11.58 }, tags: { leisure: 'playground' } },
      { type: 'node', id: 3, lat: 48.15, lon: 11.59, tags: { amenity: 'cafe' } },
      { type: 'node', id: 1, lat: 48.1371, lon: 11.5751, tags: { amenity: 'cafe', name: 'Duplicate' } },
      { type: 'node', id: 4, lat: 48.15, lon: 11.59, tags: { amenity: 'restaurant', name: 'Wirt', website: 'https://example.org', opening_hours: 'Mo-Su 10:00-22:00' } },
    ]);
    expect(venues.map((v: { id: string }) => v.id)).toEqual(['n1', 'n4', 'w2']);
    expect(venues[0]).toEqual({ id: 'n1', name: 'Café Sonne', cat: 'cafe', lat: 48.137123, lng: 11.575123 });
    expect(venues[1].web).toBe('https://example.org');
    expect(venues[2].name).toBe('Playground');
  });
});

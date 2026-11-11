#!/usr/bin/env node
// Refreshes public/data/venues.json from OpenStreetMap via the Overpass API.
// Run locally with `npm run fetch-data`; the nightly GitHub Action runs the same script.
// It only reads public data and writes one file inside this repository.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OVERPASS_ENDPOINTS, buildQuery, normalize } from '../src/lib/overpass.js';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../public/data/venues.json');
const MIN_EXPECTED = 500; // a result far below this means a broken response, not a changed city

async function query() {
  let lastError;
  // Two passes over the servers: the public Overpass instances are often briefly overloaded (HTTP 502/504).
  for (const [i, url] of [...OVERPASS_ENDPOINTS, ...OVERPASS_ENDPOINTS].entries()) {
    if (i === OVERPASS_ENDPOINTS.length) await new Promise((r) => setTimeout(r, 30_000));
    try {
      console.log(`Querying ${url} …`);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': 'sonnenseite-data-refresh (open source project)' },
        body: new URLSearchParams({ data: buildQuery() }),
        signal: AbortSignal.timeout(240_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!Array.isArray(json.elements)) throw new Error('Unexpected response shape');
      return json.elements;
    } catch (e) {
      console.warn(`  failed: ${e.message}`);
      lastError = e;
    }
  }
  throw lastError;
}

const venues = normalize(await query());
if (venues.length < MIN_EXPECTED) {
  console.error(`Only ${venues.length} venues returned; keeping the existing file.`);
  process.exit(1);
}

// Keep the old timestamp when nothing changed, so the nightly job does not commit noise.
let previous = null;
try { previous = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* first run */ }
const unchanged = previous && JSON.stringify(previous.venues) === JSON.stringify(venues);

const counts = {};
for (const v of venues) counts[v.cat] = (counts[v.cat] ?? 0) + 1;

await mkdir(dirname(OUT), { recursive: true });
await writeFile(
  OUT,
  JSON.stringify({
    generated: unchanged ? previous.generated : new Date().toISOString(),
    source: 'OpenStreetMap contributors via Overpass API, ODbL 1.0',
    counts,
    venues,
  }) + '\n',
);
console.log(`${venues.length} venues ${unchanged ? '(unchanged)' : 'written'}:`, counts);

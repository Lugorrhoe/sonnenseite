# Decisions and attribution

An honest record of who decided what. "Lukas" is the author and owner of the project. "Claude" is Anthropic's AI model, which wrote most of the code in one working session on 11 November 2026.

## Decided by Lukas

- **The product.** A terrace sun map for the Munich area, open source, with every feature free, using real data that keeps updating. The feature list was taken from the public feature comparison of an existing commercial app in this category.
- **The scope.** Munich only.
- **Where it lives.** A public repository under his GitHub account.

## Proposed by Claude and accepted by Lukas

- **Independent implementation.** Lukas first asked to reverse engineer the commercial app. Claude proposed building from scratch on open data instead: no decompiling, no use of the other product's API, data, name or design. Lukas agreed.
- **A web app, not a native app.** No app store, no cost, one link to try it. Consequence: no home screen widget, and sun alerts only while the app is open.
- **No backend.** All computation happens in the browser. The only scheduled job is a GitHub Action that refreshes the list of places.

## Decided by Claude during implementation

- **Buildings from OpenFreeMap vector tiles** instead of a preprocessed building file. The tiles are already needed for the base map, they update on their own, and no large file has to be stored in the repository. Trade off: heights are only as good as OpenStreetMap, and roofs are flat.
- **Exact ray against footprint test with a grid index** instead of rendering a shadow map on the GPU. Easier to test, and fast enough: a day's timeline is 144 rays.
- **Shadow drawing as swept quads in a thin extrusion layer**, which avoids polygon unions and avoids overlapping shadows darkening each other.
- **Moving venue points 2.5 m outside the nearest wall.** A heuristic for "where is the terrace", documented as a limit.
- **Only venues tagged with outdoor seating** are shown, so the map does not claim a terrace where none is known.
- **A minimum sun elevation of 1 degree** and a maximum shadow length of 400 m.
- **Names.** The working title "Sonnenseite", the visual design and all interface text.

## What Claude could and could not check

- Checked: unit tests, type check and production build all pass. The tests caught one real defect during development: version 2 of the SunCalc library returns degrees and a north based azimuth, where the code first assumed the older radian, south based convention.
- Confirmed by fetching it: the OpenFreeMap tile description (building layer with `render_height` and `render_min_height`, zoom 13 to 14).
- Not checked: the app running in a browser, and live responses from Overpass, Open-Meteo and Photon. The build sandbox had no browser and could not reach those services. The request formats were written from Claude's knowledge of these APIs.

## Changes after the first session

Add entries here as the project evolves: what changed, who decided, and why.

### 11 November 2026, second session: live smoke test

Lukas asked Claude to understand the project and start on it. Claude ran the app in a browser against the live services for the first time. The request formats written from memory in the first session (Overpass, Open-Meteo, Photon, OpenFreeMap tiles, the label font) all turned out to be correct. Decided by Claude:

- **Fetch script retries.** The first Overpass attempt failed with HTTP 502 and the mirror timed out, so `scripts/fetch-venues.mjs` now makes a second pass over the servers after 30 seconds.
- **Shadow margin follows the sun.** The shadow layer collected buildings 450 m around the view regardless of sun height. It now uses the longest shadow the tallest loaded building can cast, which roughly halved the redraw time per slider step.
- **Night message.** The "Sunny nearby" tab said "0 of N places are in the sun" plus an overcast note at night. It now says the sun is down.
- **First venue snapshot committed** (9,909 places), so a fresh clone does not depend on a live Overpass query.
- **MapLibre stays on version 5 for now** despite advisory GHSA-jrc7-96c5-q579, because the fix needs the unevaluated version 6 migration. Recorded in the README as a known issue. This one is Lukas's call to revisit.

### 13 November 2026: MapLibre GL 6

Lukas decided to migrate after Claude flagged the advisory. Claude moved `maplibre-gl` from 5.24 to 6.17: namespace import without the default fallback, the worker emitted as a separate asset and registered with `setWorkerUrl`, one event type adjusted. `npm audit` is clean. Checked in Chromium on the dev server and the production build; not checked in other browsers.

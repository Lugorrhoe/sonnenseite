# Sonnenseite

**Which Munich terraces are in the sun right now?**

Sonnenseite ("the sunny side") is an open source shadow map for Munich. It computes, in your browser, where building shadows fall at any date and time, and tells you which cafés, beer gardens, playgrounds and sports pitches are in the sun. No account, no API key, no server, no paywall.

**Live demo:** <https://lugorrhoe.github.io/sonnenseite/>

<!-- Add a short screen recording here once the site is live: docs/demo.gif -->

## What it does

| Feature | Status |
|---|---|
| Shadow map you can move through any date and time | Yes |
| Cafés, restaurants, bars, bakeries, beer gardens | Yes |
| Playgrounds, sports pitches, golf | Yes |
| Sun timeline for any place or any spot you tap, for any day | Yes |
| Ranking of sunny places in view, with "sun for another 2 h" or "sun from 15:20" | Yes |
| Sun hours for every month of the year, for any spot | Yes |
| Saved places | Yes, stored in your browser |
| Search for places and addresses | Yes |
| Temperature, UV, wind, humidity, seven day forecast | Yes |
| Share a place or a map view by link | Yes |
| Sun alerts for saved places | Only while the app is open (there is no server to send push messages) |
| Installable on a phone home screen | Yes, as a web app. There is no native widget. |

## Data: all open, all refreshed automatically

| What | Source | How it stays current |
|---|---|---|
| Places | [OpenStreetMap](https://www.openstreetmap.org/copyright) via the Overpass API | A GitHub Action rebuilds `public/data/venues.json` every night |
| Building footprints and heights | OpenStreetMap, served as vector tiles by [OpenFreeMap](https://openfreemap.org) | Loaded live; OpenFreeMap rebuilds its tiles regularly |
| Weather and forecast | [Open-Meteo](https://open-meteo.com/) (CC BY 4.0) | Loaded live, refreshed every 15 minutes |
| Sun position | Computed locally with [SunCalc](https://github.com/mourner/suncalc) | Always exact for the selected instant |
| Address search | [Photon](https://photon.komoot.io/) by Komoot, on OpenStreetMap data | Live |

## How it works

1. **Buildings.** For the area on screen, the app downloads the same zoom 14 vector tiles the base map uses and decodes the `building` layer: footprint polygons plus `render_height` and `render_min_height`. Everything is projected into a flat metre grid centred on Marienplatz and stored in a uniform grid index with 64 m cells.
2. **Is this spot in the sun?** A ray is cast from the spot (1.2 m above ground, roughly a seated person) towards the sun. Walking the grid cells along the ray, each candidate building is tested exactly: the ray is intersected with every wall of the footprint, and the building blocks the sun if its roof is higher than the ray where the ray enters the footprint. Courtyards (holes) and elevated building parts are handled. Shadows are followed for up to 400 m.
3. **Where is the terrace?** OpenStreetMap usually maps a café as a point inside its building. A point inside a footprint is moved 2.5 m outside the nearest wall. This is a heuristic, see the limits below.
4. **The shadow layer.** The ground shadow of an extruded footprint is the footprint swept along the shadow vector. That sweep equals the shifted footprint plus one quad per wall, so no polygon union is needed. The pieces are drawn as one paper thin `fill-extrusion` layer, because MapLibre blends such a layer as a whole and overlapping shadows therefore do not darken each other.
5. **Timeline, ranking, report.** These all repeat the ray test: every 10 minutes across a day for the timeline, forward from the selected time for the ranking, and on the 15th of each month for the yearly report.

The engine lives in `src/lib/` and has no dependency on the map, so it is tested in isolation.

## Accuracy and limits

Please read this before trusting it with your lunch break.

- **Trees, awnings and umbrellas are not modelled.** This matters most for beer gardens under chestnut trees, which will show as sunny when they are in fact pleasantly shaded.
- **Building heights come from OpenStreetMap.** Where mappers recorded neither a height nor a number of floors, the tiles carry a default and the shadow will be off. Roofs are treated as flat at the building's full height.
- **Terrace positions are a guess.** The app assumes seating is just outside the wall nearest to the mapped point. A terrace on the other side of the building, in a courtyard, or on a roof will be judged wrongly.
- **Food and drink places appear only if OpenStreetMap has an `outdoor_seating` tag for them.** If your favourite place is missing, [add the tag on OpenStreetMap](https://www.openstreetmap.org/) and it will show up after the next nightly refresh.
- **The ground is treated as flat.** That is a fair assumption for Munich, less so on the Isar slopes.
- **Clouds.** The map shows geometric shadows. Cloud cover from the forecast is shown alongside, and the app says so when the sky is overcast, but it does not predict individual clouds.
- **Sun alerts** need the app to be open.

## What is verified and what is not

Verified by the test suite (`npm test`, 21 tests):

- the ray test against the analytic shadow length of a wall, and against a brute force oracle on 400 random spots and sun positions in a random scene
- courtyards, elevated building parts, the move out of the building, and the shadow polygons
- sun position against known values for Munich (midsummer noon altitude, evening azimuth)
- time zone handling across summer and winter time
- decoding of a hand encoded vector tile into footprints at the right position and scale
- OpenStreetMap tag normalisation, including rejection of unsafe website links

Checked by hand in a live smoke test on 11 November 2026 (Chromium, dev server, real services):

- the app starts without errors; base map, 3D buildings, shadow layer and venue labels render
- Overpass returned 9,909 places for the Munich area (the first attempt failed with HTTP 502 from an overloaded server, so the fetch script now makes a second pass)
- Open-Meteo, Photon search and the OpenFreeMap building tiles respond in the formats the code expects
- place panel, day timeline, yearly sun hours, ranking, weather tab, search results and share links produce plausible output
- recomputing markers and shadows for one slider step took about 12 to 30 ms at zoom 15.4 in the old town on a laptop

Known console noise: MapLibre logs "Expected value to be of type number, but found null". It comes from the road shield filters in the OpenFreeMap Positron style (MapLibre 6 names the layers), not from this app.

Not verified: field accuracy (does the map agree with the street?). A comparison against photos of a few known terraces is the natural next step. The `Test and deploy` workflow has run successfully and the published files match a local production build byte for byte; the service worker registers and caches the app shell in that build. The `Refresh venue data` workflow ran successfully on 12 November 2026 and committed an updated snapshot. Still untested: phones, Safari and Firefox, geolocation, notifications and the installed web app.

MapLibre GL was moved from version 5 to 6 on 13 November 2026, which cleared advisory GHSA-jrc7-96c5-q579; `npm audit` reports no known vulnerabilities. Dev and production builds were rechecked in Chromium after the move.

## Run it locally

```bash
npm install
npm run fetch-data   # optional: pulls the current places from OpenStreetMap (about a minute)
npm run dev          # open the printed URL
npm test
npm run build        # static site in dist/
```

Node 22 or newer. If you skip `fetch-data`, the app queries Overpass directly on first load, which is slower.

## Deploy your own copy

1. Push the repository to GitHub.
2. In the repository settings, under **Pages**, set the source to **GitHub Actions**.
3. The `Test and deploy` workflow publishes the site on every push to `main`. The `Refresh venue data` workflow commits a fresh `venues.json` every night.

To cover another city, change `MUC` and `MUC_BBOX` in `src/lib/geo.ts` and `OVERPASS_BBOX` in `src/lib/overpass.js`.

## Roadmap

- Trees from open LiDAR surface models
- Official LoD2 building models from the Bavarian surveying office for real roof shapes
- Terrace polygons where OpenStreetMap has them (`outdoor_seating` areas)
- Measured accuracy against ground truth photos

## How this was built

This project was directed by Lukas Varga and implemented largely by Claude (Anthropic's AI model) in a pair programming session. `DECISIONS.md` records who decided what. The idea of a terrace sun map is not new and several apps offer it; this is an independent implementation written from scratch on open data. It shares no code, data or assets with any other product.

## License

Code: [MIT](LICENSE). Map data © OpenStreetMap contributors (ODbL). Base map and tiles by OpenFreeMap, schema © OpenMapTiles. Weather data by Open-Meteo (CC BY 4.0).

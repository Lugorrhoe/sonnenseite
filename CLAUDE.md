# Sonnenseite: project guide for Claude Code

Open source shadow map for Munich: which terraces are in the sun at a given date and time.
Static web app (Vite, TypeScript, MapLibre GL), no backend, no API keys. Owner: Lukas Varga (GitHub: Lugorrhoe).
Read `README.md` for the user facing description and `DECISIONS.md` for who decided what.

## Commands

```bash
npm install          # Node 22+
npm run dev          # local dev server
npm test             # vitest, 21 tests, about 1 s
npm run typecheck    # tsc --noEmit
npm run build        # typecheck + production build into dist/
npm run fetch-data   # refresh public/data/venues.json from Overpass
```

Run `npm test` and `npm run typecheck` after every change to `src/lib/`.

## Layout

| Path | Role |
|---|---|
| `src/lib/geo.ts` | Local metre frame centred on Marienplatz, point in polygon, ray against segment |
| `src/lib/shadow.ts` | `ShadowIndex` (64 m grid), `isShaded` ray test, `pushOutside`, `shadowPolygons` |
| `src/lib/sun.ts` | Sun position, state at a time, day timeline, outlook, monthly report |
| `src/lib/time.ts` | Europe/Berlin wall clock helpers. All UI times are Munich time. |
| `src/lib/buildings.ts` | Fetches and decodes OpenFreeMap zoom 14 tiles into the index |
| `src/lib/overpass.js` | Overpass query and normalisation. Plain JS because `scripts/fetch-venues.mjs` imports it in Node. |
| `src/lib/venues.ts` | Loads the snapshot, falls back to live Overpass |
| `src/lib/weather.ts` | Open-Meteo client |
| `src/main.ts` | All UI: map layers, time bar, panel tabs, search, share, alerts |
| `tests/` | Engine tests and a hand encoded vector tile test |
| `.github/workflows/` | `deploy.yml` (test, build, Pages), `data.yml` (nightly venue refresh) |

`src/lib/` must stay free of DOM and map dependencies so it remains testable in Node.

## Facts that are easy to get wrong

- **SunCalc is version 2.** `getPosition` returns degrees, azimuth clockwise from north. Version 1 used radians from south. `sunAt` converts to radians once; everything downstream uses radians, bearing clockwise from north.
- **MapLibre is pinned to version 5.** Version 6 is ESM only with a separate worker file and was not evaluated. It is imported as a namespace with a `.default` fallback in `main.ts`.
- **Coordinates:** `XY` is metres east and north of Marienplatz. Rings are open (first point not repeated), outer ring first, then holes.
- **Shadow layer** is a `fill-extrusion` 0.3 m tall on purpose, so overlapping shadows do not darken each other.
- **Building tiles:** layer `building`, properties `render_height`, `render_min_height`, `hide_3d`. Features with `hide_3d` are skipped. Missing height defaults to 6 m.
- `ShadowIndex.query` walks every grid cell in the box: never call it with a huge box.

## Current state (as of 11 November 2026)

Passing: unit tests, type check, production build.

**Live smoke test done** in Chromium against the real services: Overpass, Open-Meteo, Photon, building tiles and the label font all work. See the README section "What is verified and what is not". Not yet tested: phones, Safari, Firefox, geolocation, notifications, the GitHub workflows.

Notes from that test:
- Overpass is often overloaded (502, or 40 s for a tiny query). Retry before suspecting the query.
- The console warning "Expected value to be of type number, but found null" comes from the Positron base style, not from our layers.
- `npm audit` flags MapLibre 5 (GHSA-jrc7-96c5-q579); the fix needs the version 6 migration. Do not run `npm audit fix --force` without discussing it.
- In Claude's preview pane the page may only draw frames when a screenshot is taken, so the map `load` event can lag. That is the pane, not the app.

## Next steps, in order

1. Done: live smoke test.
2. Field check: compare five or so known terraces against reality and note results in the README.
3. `git init -b main`, first commit, push to `https://github.com/Lugorrhoe/sonnenseite`, enable Pages with source "GitHub Actions". Use a personal or GitHub noreply commit email, not a work address.
4. Record a short demo GIF into `docs/demo.gif` and link it in the README.
5. Roadmap items in the README (trees from LiDAR, LoD2 roofs, terrace polygons).

## Rules for this project

- This is an independent implementation. Do not copy code, data, names, text or design from Coffee in the Sun or any other product, and do not call their APIs.
- Only open data sources with attribution. No API keys or secrets in the repository; if a future feature needs one, stop and discuss.
- Keep honest documentation: update the "What is verified and what is not" section of the README and add an entry to `DECISIONS.md` when behaviour or scope changes.
- External content (Overpass, Photon, tiles) is untrusted input: keep escaping it with `esc()` before it reaches `innerHTML`, and keep the `https?://` check on website links.
- Ask before destructive commands, force pushes, or installing packages from anywhere but the public npm registry.

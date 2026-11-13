import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { BuildingStore } from './lib/buildings';
import { MUC, MUC_BBOX, XY, dist, toLngLat, toXY } from './lib/geo';
import { MAX_REACH, shadowPolygons } from './lib/shadow';
import {
  NIGHT, SHADE, SUN, SunState, dayTimeline, isDaylight, monthlyReport, outlook, stateAt, sunAt,
  sunMinutes, sunWindows, sunriseSunset,
} from './lib/sun';
import {
  berlinParts, berlinToDate, dateStr, dayStart, fmtDuration, fmtMinutes, fmtTime, parseDateStr,
} from './lib/time';
import { CATEGORIES, Category, Venue, loadVenues } from './lib/venues';
import { OVERCAST, Weather, hourAt, loadWeather, skyLabel } from './lib/weather';

// MapLibre 6 is ESM only and loads its worker from a separate file next to the library.
// Once bundled, that relative lookup no longer works, so the worker is emitted as an asset and named explicitly.
maplibregl.setWorkerUrl(workerUrl);

// ---------------------------------------------------------------- state

interface Place { id?: string; name: string; lat: number; lng: number; cat?: Category; hours?: string; web?: string }
type Tab = 'nearby' | 'place' | 'saved' | 'weather';
interface RankRow { v: Venue; state: SunState; sunLeft: number; sunIn: number; d: number; score: number }

const STATUS_ZOOM = 14;
const SHADOW_ZOOM = 14.6;
const PAD = MAX_REACH + 50; // metres of buildings needed beyond the area being tested

const store = new BuildingStore();
let venues: Venue[] = [];
const venueById = new Map<string, Venue>();
let venueNote = '';
let weather: Weather | null = null;
let time = new Date();
let live = true;
let selected: Place | null = null;
let tab: Tab = 'nearby';
let userXY: XY | null = null;
let ranking: RankRow[] = [];
let viewReady = false;
let playing: number | null = null;

const ls = {
  get<T>(k: string, fallback: T): T {
    try { const v = localStorage.getItem('sonnenseite.' + k); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
  },
  set(k: string, v: unknown) { try { localStorage.setItem('sonnenseite.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const cats = new Set<Category>(ls.get<Category[]>('cats', ['cafe', 'restaurant', 'bar', 'bakery', 'biergarten']));
let saved: Place[] = ls.get<Place[]>('saved', []);
let alertsOn = ls.get<boolean>('alerts', false);
const lastAlertState = new Map<string, SunState>();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const placeKey = (p: Place) => p.id ?? `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
const STATE_LABEL = ['Night', 'In the shade', 'In the sun'];
const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

// ---------------------------------------------------------------- map

const start = readHash();
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/positron',
  center: start.center ?? [MUC.lng, MUC.lat],
  zoom: start.zoom ?? 15.4,
  minZoom: 10,
  maxBounds: [[MUC_BBOX[0] - 0.12, MUC_BBOX[1] - 0.08], [MUC_BBOX[2] + 0.12, MUC_BBOX[3] + 0.08]],
  attributionControl: { compact: true, customAttribution: 'Weather: <a href="https://open-meteo.com/">Open-Meteo</a>' },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
const geolocate = new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: false });
map.addControl(geolocate, 'top-right');
geolocate.on('geolocate', (e) => {
  userXY = toXY(e.coords.longitude, e.coords.latitude);
  scheduleRefresh();
});

const pinEl = document.createElement('div');
pinEl.className = 'pin';
const pin = new maplibregl.Marker({ element: pinEl });

const empty = (): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features: [] });

map.on('load', () => {
  const layers = map.getStyle().layers ?? [];
  const firstSymbol = layers.find((l) => l.type === 'symbol')?.id;
  const vectorSource = Object.entries(map.getStyle().sources).find(([, s]) => s.type === 'vector')?.[0];

  map.addSource('shadows', { type: 'geojson', data: empty() });
  map.addLayer({
    id: 'shadows', type: 'fill-extrusion', source: 'shadows', minzoom: SHADOW_ZOOM - 0.1,
    // A paper thin extrusion instead of a fill: overlapping shadows then blend as one layer, not on top of each other.
    paint: { 'fill-extrusion-color': '#18223c', 'fill-extrusion-height': 0.3, 'fill-extrusion-base': 0, 'fill-extrusion-opacity': 0.36 },
  }, firstSymbol);

  if (vectorSource) {
    map.addLayer({
      id: 'buildings-3d', type: 'fill-extrusion', source: vectorSource, 'source-layer': 'building', minzoom: 14,
      filter: ['!=', ['get', 'hide_3d'], true],
      paint: {
        'fill-extrusion-color': '#ece7de',
        'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 6],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
        'fill-extrusion-opacity': 1,
      },
    }, firstSymbol);
  }

  map.addSource('venues', { type: 'geojson', data: empty() });
  map.addLayer({
    id: 'venues', type: 'circle', source: 'venues',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2, 14, 4.5, 17, 8],
      'circle-color': ['match', ['get', 's'], 2, '#f5a400', 1, '#5b6b82', 0, '#262c3a', '#a9b0ba'],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11, 0.5, 15, 1.6],
    },
  });
  map.addLayer({
    id: 'venue-labels', type: 'symbol', source: 'venues', minzoom: 16.2,
    layout: {
      'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11.5,
      'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true,
    },
    paint: { 'text-color': '#2b3140', 'text-halo-color': '#ffffff', 'text-halo-width': 1.4 },
  });

  map.on('mouseenter', 'venues', () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', 'venues', () => (map.getCanvas().style.cursor = ''));
  map.on('click', (e) => {
    const hit = map.queryRenderedFeatures(e.point, { layers: ['venues'] })[0];
    const v = hit && venueById.get(String(hit.properties?.id));
    if (v) select(v, false);
    else select({ name: 'Dropped pin', lat: e.lngLat.lat, lng: e.lngLat.lng }, false);
  });
  map.on('moveend', () => { scheduleRefresh(); writeHash(); });

  if (start.place) select(start.place, false);
  scheduleRefresh();
});
map.on('error', (e) => { if (!map.isStyleLoaded()) toast('The base map could not be loaded. Check your connection.'); console.warn(e.error); });

// ---------------------------------------------------------------- time

function setTime(t: Date, isLive: boolean) {
  time = t;
  live = isLive;
  syncTimeControls();
  scheduleRefresh();
  if (tab !== 'nearby') renderTab();
  writeHash();
}

function sky() {
  const p = berlinParts(time);
  return hourAt(weather, dateStr(time), p.minutes);
}

function syncTimeControls() {
  const p = berlinParts(time);
  $<HTMLInputElement>('date').value = dateStr(time);
  $<HTMLInputElement>('slider').value = String(p.minutes);
  $('clock').textContent = fmtMinutes(p.minutes);
  $('now').classList.toggle('on', live);
  const night = !isDaylight(sunAt(time));
  const h = sky();
  const overcast = !night && !!h && h.cloud >= OVERCAST;
  $('map').classList.toggle('night', night);
  $('map').classList.toggle('overcast', overcast);
  const c = live && weather ? weather.current : h;
  $('wx').textContent = c && Number.isFinite(c.temp) ? `${Math.round(c.temp)}° · ${night ? 'Night' : skyLabel(c.cloud)}` : 'Weather';
}

$('slider').addEventListener('input', (e) => {
  const d = parseDateStr($<HTMLInputElement>('date').value) ?? berlinParts(time);
  stopPlay();
  setTime(berlinToDate(d.y, d.m, d.d, Number((e.target as HTMLInputElement).value)), false);
});
$('date').addEventListener('change', (e) => {
  const d = parseDateStr((e.target as HTMLInputElement).value);
  if (d) setTime(berlinToDate(d.y, d.m, d.d, berlinParts(time).minutes), false);
});
$('now').addEventListener('click', () => { stopPlay(); setTime(new Date(), true); });
$('play').addEventListener('click', () => (playing ? stopPlay() : startPlay()));

function startPlay() {
  $('play').textContent = 'Stop';
  $('play').classList.add('on');
  const { sunrise } = sunriseSunset(time);
  if (!isDaylight(sunAt(time)) && sunrise) setTime(sunrise, false);
  playing = window.setInterval(() => {
    const next = new Date(time.getTime() + 10 * 60_000);
    if (dateStr(next) !== dateStr(time) || !isDaylight(sunAt(next))) return stopPlay();
    setTime(next, false);
  }, 140);
}
function stopPlay() {
  if (playing) clearInterval(playing);
  playing = null;
  $('play').textContent = 'Play';
  $('play').classList.remove('on');
}

// ---------------------------------------------------------------- map refresh

let refreshQueued = false;
function scheduleRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  requestAnimationFrame(() => { refreshQueued = false; refreshMap(); });
}

let rankTimer = 0;
function scheduleRanking() {
  clearTimeout(rankTimer);
  rankTimer = window.setTimeout(() => { computeRanking(); if (tab === 'nearby') renderTab(); }, 180);
}

function viewBox(): { min: XY; max: XY } {
  const b = map.getBounds();
  return { min: toXY(b.getWest(), b.getSouth()), max: toXY(b.getEast(), b.getNorth()) };
}

function spotOf(v: Venue): XY | null {
  if (v.spot) return v.spot;
  if (!store.readyAround(v.xy, 80)) return null;
  v.spot = store.index.pushOutside(v.xy);
  return v.spot;
}

function refreshMap() {
  if (!map.getSource('venues')) return;
  const zoom = map.getZoom();
  const { min, max } = viewBox();
  const pos = sunAt(time);
  const day = isDaylight(pos);
  let hint = '';

  viewReady = false;
  if (zoom >= STATUS_ZOOM) {
    const [w, s] = toLngLat(min[0] - PAD, min[1] - PAD);
    const [e, n] = toLngLat(max[0] + PAD, max[1] + PAD);
    viewReady = store.ready(w, s, e, n);
    if (!viewReady) {
      hint = 'Loading buildings…';
      store.ensure(w, s, e, n).then(() => {
        // Only redraw once the data is really there; otherwise a failed download would retry on every frame.
        if (store.ready(w, s, e, n)) scheduleRefresh();
        else toast('Building data could not be loaded. Move the map to try again.');
      });
    }
  } else {
    hint = 'Zoom in to see sun and shade';
  }

  // Venue markers
  const features: GeoJSON.Feature[] = [];
  for (const v of venues) {
    if (!cats.has(v.cat)) continue;
    let s = -1;
    if (viewReady && v.xy[0] >= min[0] && v.xy[0] <= max[0] && v.xy[1] >= min[1] && v.xy[1] <= max[1]) {
      const spot = spotOf(v);
      if (spot) s = day ? (store.index.isShaded(spot, pos.bearing, pos.altitude) ? SHADE : SUN) : NIGHT;
    }
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.lng, v.lat] }, properties: { id: v.id, name: v.name, s } });
  }
  (map.getSource('venues') as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features });

  // Shadow layer
  const shadows: GeoJSON.Feature[] = [];
  if (viewReady && day && zoom >= SHADOW_ZOOM) {
    // Only buildings whose shadow can reach the view: the tallest one sets the margin.
    const pad = Math.min(MAX_REACH, store.index.maxH / Math.tan(pos.altitude)) + 10;
    const buildings = store.index.query(min[0] - pad, min[1] - pad, max[0] + pad, max[1] + pad);
    if (buildings.length <= 7000) {
      for (const b of buildings) {
        const coords = shadowPolygons(b, pos.bearing, pos.altitude).map((rings) =>
          rings.map((ring) => {
            const out = ring.map(([x, y]) => toLngLat(x, y));
            out.push(out[0]);
            return out;
          }),
        );
        shadows.push({ type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: coords }, properties: {} });
      }
    }
  } else if (viewReady && day && zoom < SHADOW_ZOOM) {
    hint = 'Zoom in a little more to see the shadows';
  }
  (map.getSource('shadows') as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features: shadows });

  if (!hint && !day) hint = 'The sun is down at this time';
  const h = sky();
  if (!hint && h && h.cloud >= OVERCAST) hint = `Overcast (${Math.round(h.cloud)}% cloud): the map shows where the sun would reach`;
  $('hint').textContent = hint;
  $('hint').hidden = !hint;

  scheduleRanking();
}

function computeRanking() {
  ranking = [];
  if (!viewReady) return;
  const { min, max } = viewBox();
  const centre: XY =
    userXY && userXY[0] >= min[0] && userXY[0] <= max[0] && userXY[1] >= min[1] && userXY[1] <= max[1]
      ? userXY
      : [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2];
  const near: { v: Venue; spot: XY; d: number }[] = [];
  for (const v of venues) {
    if (!cats.has(v.cat)) continue;
    if (v.xy[0] < min[0] || v.xy[0] > max[0] || v.xy[1] < min[1] || v.xy[1] > max[1]) continue;
    const spot = spotOf(v);
    if (spot) near.push({ v, spot, d: dist(v.xy, centre) });
  }
  near.sort((a, b) => a.d - b.d);
  for (const { v, spot, d } of near.slice(0, 250)) {
    const o = outlook(store.index, spot, time);
    const score = o.state === SUN ? 10_000 + o.sunLeft : o.state === SHADE ? (o.sunIn >= 0 ? 5_000 - o.sunIn : 1_000) : 0;
    ranking.push({ v, state: o.state, sunLeft: o.sunLeft, sunIn: o.sunIn, d, score });
  }
  ranking.sort((a, b) => b.score - a.score || a.d - b.d);
}

// ---------------------------------------------------------------- panel

function outlookText(state: SunState, sunLeft: number, sunIn: number): string {
  if (state === NIGHT) return 'Night';
  if (state === SUN) {
    const { sunset } = sunriseSunset(time);
    const untilSet = sunset ? (sunset.getTime() - time.getTime()) / 60_000 : Infinity;
    return sunLeft >= untilSet - 25 ? 'Sun until sunset' : `Sun for another ${fmtDuration(sunLeft)}`;
  }
  return sunIn >= 0 ? `Sun from ${fmtTime(new Date(time.getTime() + sunIn * 60_000))}` : 'No more sun today';
}

function renderTab() {
  document.querySelectorAll<HTMLButtonElement>('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  const body = $('body');
  if (tab === 'nearby') body.innerHTML = nearbyHtml();
  else if (tab === 'saved') body.innerHTML = savedHtml();
  else if (tab === 'weather') body.innerHTML = weatherHtml();
  else void renderPlace();
}

function nearbyHtml(): string {
  const when = live ? 'right now' : `on ${dateStr(time)} at ${fmtTime(time)}`;
  if (map.getZoom() < STATUS_ZOOM) return `<p class="muted">Zoom in to a neighbourhood to rank the places there.</p>${venueNote}`;
  if (!viewReady) return '<p class="muted">Loading buildings…</p>';
  if (!ranking.length) return `<p class="muted">No places of the selected kinds in this part of the map.</p>${venueNote}`;
  if (!isDaylight(sunAt(time))) return `<p class="muted">The sun is down ${esc(when)}. Move the time slider to see where it will shine.</p>${venueNote}`;
  const sunny = ranking.filter((r) => r.state === SUN).length;
  const h = sky();
  const cloud = h && h.cloud >= OVERCAST ? `<p class="small muted">It is overcast, so expect little direct sunshine even at sunny spots.</p>` : '';
  const rows = ranking
    .map((r, i) => `<li data-act="venue" data-id="${esc(r.v.id)}">
      <span class="n">${i + 1}</span>
      <span><div class="name"><span class="dot s${r.state}"></span>${esc(r.v.name)}</div>
      <div class="sub">${esc(outlookText(r.state, r.sunLeft, r.sunIn))}</div></span>
      <span class="sub">${r.d < 1000 ? `${Math.round(r.d / 10) * 10} m` : `${(r.d / 1000).toFixed(1)} km`}</span></li>`)
    .join('');
  return `<p><b>${sunny} of ${ranking.length}</b> places in view are in the sun ${esc(when)}.</p>${cloud}<ol class="rank">${rows}</ol>${venueNote}`;
}

async function renderPlace() {
  const body = $('body');
  if (!selected) {
    body.innerHTML = '<p class="muted">Tap a place, or any spot on the map, to see its sun timeline.</p>';
    return;
  }
  const p = selected;
  const xy = toXY(p.lng, p.lat);
  if (!store.readyAround(xy, PAD)) {
    body.innerHTML = `<h2>${esc(p.name)}</h2><p class="muted">Loading buildings…</p>`;
    await store.ensureAround(xy, PAD);
    if (selected !== p || tab !== 'place') return;
  }
  const venue = p.id ? venueById.get(p.id) : undefined;
  const spot = (venue && spotOf(venue)) || store.index.pushOutside(xy);
  const parts = berlinParts(time);
  const states = dayTimeline(store.index, spot, dayStart(time));
  const now = stateAt(store.index, spot, time);
  const windows = sunWindows(states);
  const o = outlook(store.index, spot, time);
  const report = monthlyReport(store.index, spot, parts.y);
  const maxH = Math.max(1, ...report.map((r) => r.daylightHours));
  const isSaved = saved.some((s) => placeKey(s) === placeKey(p));
  const cat = p.cat ? CATEGORIES.find((c) => c.id === p.cat)?.label ?? '' : 'Any spot';
  const h = sky();

  body.innerHTML = `
    <h2>${esc(p.name)}</h2>
    <p class="muted small">${esc(cat)}${p.hours ? ` · ${esc(p.hours)}` : ''}</p>
    <p><span class="badge s${now}">${STATE_LABEL[now]}</span> <span class="muted">${esc(fmtTime(time))} · ${esc(outlookText(o.state, o.sunLeft, o.sunIn))}</span></p>
    ${h && now === SUN && h.cloud >= OVERCAST ? '<p class="small muted">The spot is clear of shadows, but the sky is overcast.</p>' : ''}
    <div class="row">
      <button class="btn ${isSaved ? '' : 'primary'}" data-act="save">${isSaved ? 'Remove from saved' : 'Save'}</button>
      <button class="btn" data-act="share">Share</button>
      ${p.web ? `<a class="btn" href="${esc(p.web)}" target="_blank" rel="noopener noreferrer">Website</a>` : ''}
    </div>
    <h3>Sun on ${esc(dateStr(time))}</h3>
    <div class="timeline">${states.map((s) => `<i class="s${s}"></i>`).join('')}<div class="cursor" style="left:${(parts.minutes / 1440) * 100}%"></div></div>
    <div class="axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
    <p>${windows.length
      ? `${windows.map((w) => `${fmtMinutes(w.from)} to ${fmtMinutes(w.to)}`).join(', ')} <span class="muted">(${fmtDuration(sunMinutes(states))} of direct sun)</span>`
      : '<span class="muted">No direct sun on this day.</span>'}</p>
    <p class="small muted">Change the date below the map to see any other day.</p>
    <h3>Sun hours through the year</h3>
    <div class="bars">${report.map((r) => `<div class="bar" title="${r.sunHours.toFixed(1)} h of ${r.daylightHours.toFixed(1)} h daylight"><b style="height:${(r.sunHours / maxH) * 100}%"></b><span>${r.sunHours.toFixed(r.sunHours < 10 ? 1 : 0)}</span></div>`).join('')}</div>
    <div class="barlabels">${MONTHS.map((m) => `<span>${m}</span>`).join('')}</div>
    <p class="small muted">Hours of direct sun on the 15th of each month in ${parts.y}, for a cloudless day. Buildings only: trees and awnings are not modelled.</p>`;
}

function savedHtml(): string {
  const canNotify = 'Notification' in window;
  const list = saved.length
    ? `<ol class="rank">${saved.map((p, i) => `<li data-act="saved" data-i="${i}"><span class="n">${i + 1}</span><span><div class="name">${esc(p.name)}</div><div class="sub" id="saved-${i}">…</div></span><span></span></li>`).join('')}</ol>`
    : '<p class="muted">Nothing saved yet. Open a place and press Save.</p>';
  queueMicrotask(fillSavedStates);
  return `${list}
    <h3>Sun alerts</h3>
    <p class="small muted">Get a notification when the sun reaches a saved place. This works while Sonnenseite is open in a tab or installed and running: there is no server behind this app that could send a push message.</p>
    <button class="btn ${alertsOn ? '' : 'primary'}" data-act="alerts" ${canNotify ? '' : 'disabled'}>${alertsOn ? 'Turn alerts off' : 'Turn alerts on'}</button>
    ${canNotify ? '' : '<p class="small muted">This browser does not support notifications.</p>'}`;
}

async function fillSavedStates() {
  for (let i = 0; i < saved.length; i++) {
    const p = saved[i];
    const xy = toXY(p.lng, p.lat);
    await store.ensureAround(xy, PAD);
    const el = document.getElementById(`saved-${i}`);
    if (!el || !store.readyAround(xy, PAD)) continue;
    const o = outlook(store.index, store.index.pushOutside(xy), time);
    el.innerHTML = `<span class="dot s${o.state}"></span>${esc(outlookText(o.state, o.sunLeft, o.sunIn))}`;
  }
}

function weatherHtml(): string {
  if (!weather) return '<p class="muted">Weather is not available right now.</p>';
  const c = weather.current;
  const date = dateStr(time);
  const selHour = Math.floor(berlinParts(time).minutes / 60);
  const rows = weather.hours.filter((h) => h.time.startsWith(date));
  const f = (n: number, digits = 0) => (Number.isFinite(n) ? n.toFixed(digits) : '');
  const table = rows.length
    ? `<table class="wx"><thead><tr><th>Time</th><th>Sky</th><th>°C</th><th>UV</th><th>Wind km/h</th><th>Hum. %</th><th>Rain %</th></tr></thead><tbody>${rows
        .map((h) => `<tr class="${Number(h.time.slice(11, 13)) === selHour ? 'sel' : ''}"><td>${h.time.slice(11)}</td><td>${esc(skyLabel(h.cloud))}</td><td>${f(h.temp)}</td><td>${f(h.uv, 1)}</td><td>${f(h.wind)}</td><td>${f(h.humidity)}</td><td>${f(h.rain)}</td></tr>`)
        .join('')}</tbody></table>`
    : '<p class="muted">The forecast covers the next seven days. Pick a closer date to see it.</p>';
  return `
    <h3 style="margin-top:0">Munich now</h3>
    <div class="kpis">
      <div><b>${f(c.temp)}°</b><span>feels ${f(c.feels)}°</span></div>
      <div><b>${f(c.uv, 1)}</b><span>UV index</span></div>
      <div><b>${f(c.cloud)}%</b><span>${esc(skyLabel(c.cloud))}</span></div>
      <div><b>${f(c.wind)}</b><span>km/h wind</span></div>
      <div><b>${f(c.humidity)}%</b><span>humidity</span></div>
      <div><b>${esc(fmtTime(weather.fetchedAt))}</b><span>updated</span></div>
    </div>
    <h3>Forecast for ${esc(date)}</h3>${table}
    <p class="small muted">Weather data by <a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">Open-Meteo</a>.</p>`;
}

$('tabs').addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-tab]');
  if (!t) return;
  tab = t.dataset.tab as Tab;
  $('panel').classList.remove('min');
  renderTab();
});
$('collapse').addEventListener('click', () => $('panel').classList.toggle('min'));
$('wx').addEventListener('click', () => { tab = 'weather'; $('panel').classList.remove('min'); renderTab(); });

$('body').addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (act === 'venue') {
    const v = venueById.get(el.dataset.id ?? '');
    if (v) select(v, true);
  } else if (act === 'saved') {
    const p = saved[Number(el.dataset.i)];
    if (p) select(p, true);
  } else if (act === 'save' && selected) {
    const k = placeKey(selected);
    const i = saved.findIndex((s) => placeKey(s) === k);
    if (i >= 0) saved.splice(i, 1);
    else saved.push({ id: selected.id, name: selected.name, lat: selected.lat, lng: selected.lng, cat: selected.cat, hours: selected.hours, web: selected.web });
    ls.set('saved', saved);
    renderTab();
  } else if (act === 'share') {
    void share();
  } else if (act === 'alerts') {
    void toggleAlerts();
  }
});

function select(p: Place | Venue, fly: boolean) {
  selected = { id: p.id, name: p.name, lat: p.lat, lng: p.lng, cat: p.cat, hours: p.hours, web: p.web };
  pin.setLngLat([p.lng, p.lat]).addTo(map);
  if (fly) map.flyTo({ center: [p.lng, p.lat], zoom: Math.max(map.getZoom(), 16.5), speed: 1.6 });
  tab = 'place';
  $('panel').classList.remove('min');
  renderTab();
  writeHash();
}

// ---------------------------------------------------------------- categories

function renderCats() {
  $('cats').innerHTML = CATEGORIES.map((c) => `<button class="chip ${cats.has(c.id) ? 'on' : ''}" data-cat="${c.id}">${esc(c.label)}</button>`).join('');
}
$('cats').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-cat]');
  if (!b) return;
  const c = b.dataset.cat as Category;
  if (cats.has(c)) cats.delete(c);
  else cats.add(c);
  ls.set('cats', [...cats]);
  renderCats();
  scheduleRefresh();
});

// ---------------------------------------------------------------- search

let searchTimer = 0;
let searchAbort: AbortController | null = null;
let searchResults: Place[] = [];

$('q').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(runSearch, 300);
});
$('q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && searchResults[0]) pickResult(0);
  if (e.key === 'Escape') $('results').hidden = true;
});
$('results').addEventListener('click', (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-i]');
  if (li) pickResult(Number(li.dataset.i));
});
document.addEventListener('click', (e) => { if (!(e.target as HTMLElement).closest('#search')) $('results').hidden = true; });

async function runSearch() {
  const q = $<HTMLInputElement>('q').value.trim();
  searchAbort?.abort();
  if (q.length < 2) { $('results').hidden = true; return; }
  const needle = q.toLowerCase();
  const local: Place[] = venues.filter((v) => v.name.toLowerCase().includes(needle)).slice(0, 6);
  showResults(local, []);
  if (q.length < 3) return;
  searchAbort = new AbortController();
  try {
    // Photon: an open geocoder on OpenStreetMap data, no key needed.
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=5&lat=${MUC.lat}&lon=${MUC.lng}&bbox=${MUC_BBOX.join(',')}`;
    const r = await fetch(url, { signal: searchAbort.signal });
    if (!r.ok) return;
    const j = (await r.json()) as { features: { geometry: { coordinates: [number, number] }; properties: Record<string, string> }[] };
    const remote: Place[] = j.features.map((f) => {
      const p = f.properties;
      const street = [p.street, p.housenumber].filter(Boolean).join(' ');
      return { name: p.name || street || p.city || 'Address', lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], hours: [p.name ? street : '', p.district || p.city].filter(Boolean).join(', ') };
    });
    showResults(local, remote);
  } catch { /* aborted or offline: local results stay */ }
}

function showResults(local: Place[], remote: Place[]) {
  searchResults = [...local, ...remote];
  const item = (p: Place, i: number, sub: string) => `<li data-i="${i}">${esc(p.name)}<small>${esc(sub)}</small></li>`;
  $('results').innerHTML = searchResults.length
    ? searchResults.map((p, i) => item(p, i, i < local.length ? CATEGORIES.find((c) => c.id === p.cat)?.label ?? '' : p.hours ?? '')).join('')
    : '<li class="muted">No matches</li>';
  $('results').hidden = false;
}

function pickResult(i: number) {
  const p = searchResults[i];
  if (!p) return;
  $('results').hidden = true;
  // For address results the subtitle was parked in `hours`; do not show it as opening hours.
  select(p.id ? p : { name: p.name, lat: p.lat, lng: p.lng }, true);
}

// ---------------------------------------------------------------- share and URL state

function stateParams(): URLSearchParams {
  const c = map.getCenter();
  const q = new URLSearchParams({ z: map.getZoom().toFixed(2), c: `${c.lat.toFixed(5)},${c.lng.toFixed(5)}` });
  if (!live) q.set('t', `${dateStr(time)}T${fmtTime(time)}`);
  if (selected) q.set('p', `${selected.lat.toFixed(5)},${selected.lng.toFixed(5)},${selected.id ?? ''},${selected.name}`);
  return q;
}

let hashTimer = 0;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = window.setTimeout(() => history.replaceState(null, '', '#' + stateParams().toString()), 400);
}

function readHash(): { center?: [number, number]; zoom?: number; place?: Place } {
  const out: { center?: [number, number]; zoom?: number; place?: Place } = {};
  try {
    const q = new URLSearchParams(location.hash.slice(1));
    const z = Number(q.get('z'));
    if (z >= 10 && z <= 20) out.zoom = z;
    const c = (q.get('c') ?? '').split(',').map(Number);
    if (c.length === 2 && c.every(Number.isFinite)) out.center = [c[1], c[0]];
    const t = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(q.get('t') ?? '');
    if (t) { time = berlinToDate(+t[1], +t[2], +t[3], +t[4] * 60 + +t[5]); live = false; }
    const p = q.get('p');
    if (p) {
      const [lat, lng, id, ...name] = p.split(',');
      if (Number.isFinite(+lat) && Number.isFinite(+lng)) out.place = { lat: +lat, lng: +lng, id: id || undefined, name: name.join(',').slice(0, 80) || 'Shared spot' };
    }
  } catch { /* ignore a malformed link */ }
  return out;
}

async function share() {
  const url = `${location.origin}${location.pathname}#${stateParams().toString()}`;
  const title = selected ? `${selected.name} on Sonnenseite` : 'Sonnenseite shadow map';
  try {
    if (navigator.share) await navigator.share({ title, url });
    else { await navigator.clipboard.writeText(url); toast('Link copied'); }
  } catch { /* the visitor cancelled */ }
}

// ---------------------------------------------------------------- alerts

async function toggleAlerts() {
  if (!alertsOn) {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Notifications are blocked for this site.'); return; }
  }
  alertsOn = !alertsOn;
  ls.set('alerts', alertsOn);
  lastAlertState.clear();
  renderTab();
  if (alertsOn) void checkAlerts();
}

async function checkAlerts() {
  if (!alertsOn || !('Notification' in window) || Notification.permission !== 'granted') return;
  const now = new Date();
  const h = hourAt(weather, dateStr(now), berlinParts(now).minutes);
  for (const p of saved) {
    const xy = toXY(p.lng, p.lat);
    await store.ensureAround(xy, PAD);
    if (!store.readyAround(xy, PAD)) continue;
    const s = stateAt(store.index, store.index.pushOutside(xy), now);
    const k = placeKey(p);
    const before = lastAlertState.get(k);
    lastAlertState.set(k, s);
    if (before === SHADE && s === SUN && !(h && h.cloud >= OVERCAST)) {
      new Notification(`${p.name} is in the sun`, { body: 'The sun has just reached this spot.', icon: 'icon.svg', tag: k });
    }
  }
}

// ---------------------------------------------------------------- misc

let toastTimer = 0;
function toast(msg: string) {
  $('toast').textContent = msg;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => ($('toast').hidden = true), 3500);
}

async function refreshWeather() {
  try { weather = await loadWeather(); } catch (e) { console.warn('Weather failed', e); }
  syncTimeControls();
  scheduleRefresh();
  if (tab === 'weather') renderTab();
}

async function init() {
  renderCats();
  syncTimeControls();
  renderTab();
  void refreshWeather();
  try {
    const data = await loadVenues();
    venues = data.venues;
    for (const v of venues) venueById.set(v.id, v);
    const when = data.generated ? dateStr(new Date(data.generated)) : 'unknown date';
    venueNote = `<p class="small muted">${venues.length.toLocaleString('en')} places from OpenStreetMap, ${data.source === 'live' ? 'fetched live just now' : `snapshot of ${esc(when)}`}. Food and drink places appear only if mappers recorded outdoor seating.</p>`;
    const p = selected;
    if (p?.id && venueById.has(p.id)) select(venueById.get(p.id)!, false);
  } catch (e) {
    console.warn(e);
    venueNote = '<p class="small muted">The list of places could not be loaded. The shadow map still works: tap any spot.</p>';
    toast('Places could not be loaded.');
  }
  scheduleRefresh();
  if (tab === 'nearby') renderTab();

  setInterval(() => { if (live) setTime(new Date(), true); }, 30_000);
  setInterval(() => void checkAlerts(), 60_000);
  setInterval(() => void refreshWeather(), 15 * 60_000);

  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => undefined);
  }
}

void init();

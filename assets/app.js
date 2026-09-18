/* =========================================================================
   Night Owl - Kolkata
   Single-page directory: Leaflet + a static GeoJSON file + the Geolocation API.

   No build step, no server, no API keys. Everything below runs from
   GitHub Pages as plain static files, using only relative paths.
   ========================================================================= */

'use strict';

/* ---------------------------------------------------------------- config */

const DATA_URL = 'data/locations.geojson';
const KOLKATA = { lat: 22.5726, lng: 88.3639 };

const ICONS = {
  pharmacy: '<svg viewBox="0 0 24 24"><path d="M12 5.5v13M5.5 12h13"/></svg>',
  food: '<svg viewBox="0 0 24 24"><path d="M7 3v6.5a2.5 2.5 0 0 0 5 0V3M9.5 12v9"/><path d="M17.5 3c-1.6 2-2.5 4.1-2.5 6.5 0 1.8.9 2.9 1.9 3.3V21"/></svg>',
  fuel: '<svg viewBox="0 0 24 24"><path d="M4.5 21V6a2 2 0 0 1 2-2h3.6a2 2 0 0 1 2 2v15M3.5 21h10.6M12.1 9.5h2.4a2 2 0 0 1 2 2v6a1.8 1.8 0 0 0 3.6 0V9.6L17.1 5.6M7 8.5h3.6"/></svg>',
  transit: '<svg viewBox="0 0 24 24"><path d="M12 3.2 19 6v5.7c0 4.1-3 6.7-7 9.2-4-2.5-7-5.1-7-9.2V6l7-2.8z"/><path d="m9.2 11.8 2.1 2.2 3.7-3.9"/></svg>'
};

const CATS = {
  pharmacy: { label: '24/7 pharmacy', plural: 'pharmacies', color: '#81C784', icon: ICONS.pharmacy },
  food:     { label: 'Late-night food', plural: 'food spots', color: '#FFB74D', icon: ICONS.food },
  fuel:     { label: 'Petrol & mechanic', plural: 'pumps & mechanics', color: '#4DD0E1', icon: ICONS.fuel },
  transit:  { label: 'Safe transit pickup', plural: 'safe pickup points', color: '#B39DDB', icon: ICONS.transit }
};

/* Tile sources.

   Why not the usual CARTO Dark Matter URL (`{s}.basemaps.cartocdn.com/dark_all/...`)?
   It is still the best-looking dark basemap, but CARTO now requires an API key for
   the basemap CDN and stamps "API KEY REQUIRED" diagonally across every keyless tile.
   A watermarked map is worse than no map, so the default here is Esri's dark canvas,
   which needs no key and carries no overlay. Two tile layers (base + label reference)
   are stacked inside the tile pane to get roads and light-grey place labels.
   If you do hold a CARTO key, add its URL back with `?api_key=...` and restore the
   attribution string - see README.

   Esri's REST tile services are served from a single host (no {s} subdomains) and use
   {z}/{y}/{x} order, not {z}/{x}/{y}. */
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const ESRI_ATTRIB = 'Tiles &copy; <a href="https://www.esri.com" target="_blank" rel="noopener">Esri</a> &middot; Esri, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

const LAYERS = {
  dark: {
    label: 'Night',
    /* Base + labels. detectRetina stays off: Esri has no @2x tiles, and asking for
       one zoom level up would break at the top of the range. */
    tiles: [
      { url: `${ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`, options: { maxNativeZoom: 16 } },
      { url: `${ESRI}/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, options: { maxNativeZoom: 16 } }
    ],
    attrib: ESRI_ATTRIB
  },
  colour: {
    label: 'Colour',
    tiles: [{ url: `${ESRI}/World_Street_Map/MapServer/tile/{z}/{y}/{x}`, options: { maxNativeZoom: 19 } }],
    attrib: ESRI_ATTRIB
  },
  satellite: {
    label: 'Satellite',
    tiles: [{ url: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, options: { maxNativeZoom: 19 } }],
    attrib: 'Imagery &copy; <a href="https://www.esri.com" target="_blank" rel="noopener">Esri</a>, Maxar, Earthstar Geographics'
  }
};

/* ---------------------------------------------------------------- state */

const PAGE_SIZE = 48;      // cards rendered per page of the list

const state = {
  features: [],
  markers: new Map(),
  visible: [],
  shown: PAGE_SIZE,
  category: 'all',
  openOnly: false,
  query: '',
  sortNearest: false,
  user: null,          // { lat, lng, accuracy }
  userDistanceKm: null,
  selectedId: null,
  layer: 'dark',
  openSignature: ''    // detects when the clock flips a place open/closed
};

/* ---------------------------------------------------------------- helpers */

const $ = (sel) => document.querySelector(sel);
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function fmtClock(minutes) {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function fmtDuration(minutes) {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} m` : `${h} h`;
}

/** Distance in km between two {lat,lng} points (haversine, mean Earth radius). */
function distKm(a, b) {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function fmtDistance(km) {
  if (km == null) return '';
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}

function latLngOf(f) {
  return L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0]);
}

/**
 * Is this place open right now?
 * A close time earlier than the open time means the window wraps past midnight
 * (the whole point of this app), so the comparison flips.
 */
function openState(props, now = new Date()) {
  const kind = (open, status, label) => ({ open, status, label });

  if (props.closedDays && props.closedDays.includes(now.getDay())) {
    return kind(false, 'closed', 'Closed today');
  }
  if (props.always) return kind(true, 'open', 'Open 24 hours');

  const nowMin = now.getHours() * 60 + now.getMinutes();
  const openMin = toMinutes(props.open);
  const closeMin = toMinutes(props.close);
  const wraps = closeMin <= openMin;
  const isOpen = wraps
    ? nowMin >= openMin || nowMin < closeMin
    : nowMin >= openMin && nowMin < closeMin;

  if (!isOpen) {
    const until = (openMin - nowMin + 1440) % 1440;
    return kind(false, 'closed', `Closed &middot; opens ${fmtClock(openMin)}${until <= 720 ? ` (in ${fmtDuration(until)})` : ''}`);
  }
  const left = (closeMin - nowMin + 1440) % 1440;
  if (left <= 60) return kind(true, 'soon', `Closing in ${fmtDuration(left)}`);
  return kind(true, 'open', `Open &middot; till ${fmtClock(closeMin)}`);
}

/**
 * Static sites fail silently: a thrown error leaves a half-built page and no clue.
 * Anything unexpected is surfaced in the UI (and the console) instead - which is
 * exactly what you want when you are debugging a fork on your phone at 2 AM.
 */
function reportError(label, err) {
  const detail = (err && (err.stack || err.message)) || String(err);
  console.error(`[Night Owl] ${label}:`, err);
  const status = $('#statusline');
  if (status) status.textContent = 'Something broke while loading';
  const el = $('#notice');
  if (el) {
    el.hidden = false;
    el.innerHTML = `<b>${esc(label)}</b><br>
      <span class="muted" style="font-size:11.5px">${esc(detail)}</span>`;
  }
}

window.addEventListener('error', (e) => reportError('Script error', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => reportError('Startup failed', e.reason));

let toastTimer = null;
function toast(html, ms = 4200) {
  const el = $('#toast');
  el.innerHTML = html;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('is-on'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('is-on');
    setTimeout(() => { el.hidden = true; }, 260);
  }, ms);
}

/* ---------------------------------------------------------------- map */

const map = L.map('map', {
  center: [KOLKATA.lat, KOLKATA.lng],
  zoom: 12,
  /* Explicit maxZoom, not just on the tile layers: the cluster plugin refuses to
     attach to a map whose getMaxZoom() is still Infinity at addLayer time. */
  maxZoom: 19,
  zoomControl: true,
  attributionControl: false,   // attribution is rendered in the UI chrome instead
  zoomSnap: 0.5,
  wheelPxPerZoomLevel: 90,
  worldCopyJump: true
});

let tileLayers = [];

function setLayer(key) {
  const cfg = LAYERS[key];
  if (!cfg) return;
  state.layer = key;
  tileLayers.forEach((layer) => layer.remove());
  tileLayers = cfg.tiles.map((t) => L.tileLayer(t.url, Object.assign(
    { className: 'tiles tiles--' + key, crossOrigin: true, maxZoom: 19 },
    t.options
  )).addTo(map));
  // The map container keeps a #121212 background, so the gap before the first
  // tiles arrive is dark rather than a white flash.
  $('#attribution').innerHTML = cfg.attrib;
  document.querySelectorAll('.seg').forEach((btn) => {
    const on = btn.dataset.layer === key;
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-checked', String(on));
  });
}

/** Cluster bubble: same glass language as a marker, sized and tinted by content. */
function clusterIcon(cluster) {
  const kids = cluster.getAllChildMarkers();
  const count = cluster.getChildCount();
  const cats = new Set(kids.map((m) => m.__cat));
  const single = cats.size === 1 ? [...cats][0] : null;
  // A single-category cluster borrows that category's accent; a mixed one uses the
  // app's cool neutral (#8AB4F8 at a low mix) rather than a bright grey disc.
  const color = single && CATS[single] ? CATS[single].color : '#8AB4F8';
  // The smallest bubble stays a full 48px tap target.
  const size = count < 10 ? 48 : (count < 25 ? 56 : 64);
  const places = count === 1 ? '1 place' : `${count} places`;
  return L.divIcon({
    className: 'cluster-wrap',
    /* The visible number is decoration; screen readers get the real sentence. The
       title goes on the inner div because Leaflet's divIcon ignores options.title. */
    html: `<div class="cluster" title="${places} here - tap to zoom in" style="--c:${color};--sz:${size}px">
             <span class="cluster__ring"></span>
             <span class="cluster__n" aria-hidden="true">${count}</span>
             <span class="sr-only">${places} here, tap to zoom in</span>
           </div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2]
  });
}

/* Clustering keeps 37 pins tappable at city zoom instead of one overlap blob.
   If the plugin fails to load, fall back to a plain layer group. */
const markerLayer = typeof L.markerClusterGroup === 'function'
  ? L.markerClusterGroup({
      maxClusterRadius: 58,
      showCoverageOnHover: false,
      spiderfyOnMaxZoom: true,
      animate: !reduceMotion,
      spiderLegPolylineOptions: { weight: 1.5, color: '#8AB4F8', opacity: 0.5 },
      iconCreateFunction: clusterIcon
    }).addTo(map)
  : L.layerGroup().addTo(map);

const meLayer = L.layerGroup().addTo(map);

function markerHtml(f, active) {
  const p = f.properties;
  const cat = CATS[p.category] || CATS.food;
  const st = openState(p);
  return `<div class="mk${active ? ' is-active' : ''} ${st.open ? 'is-open' : 'is-closed'}"
               style="--c:${cat.color}">
            <span class="mk__halo"></span>
            <span class="mk__dot">${cat.icon}<span class="mk__badge"></span></span>
          </div>`;
}

function iconFor(f, active) {
  return L.divIcon({
    className: 'mk-wrap',
    html: markerHtml(f, active),
    iconSize: [48, 48],
    iconAnchor: [24, 24],
    popupAnchor: [0, -20]
  });
}

function buildMarkers() {
  markerLayer.clearLayers();
  state.markers.clear();
  state.visible.forEach((f) => {
    const p = f.properties;
    const cat = CATS[p.category] || CATS.food;
    const marker = L.marker(latLngOf(f), {
      icon: iconFor(f, state.selectedId === p.id),
      riseOnHover: true,
      title: p.name,
      alt: `${p.name}, ${cat.label}`
    });
    marker.__cat = p.category;
    marker.on('click', () => select(p.id, { fromMarker: true }));
    marker.addTo(markerLayer);
    state.markers.set(p.id, marker);
  });
}

/** Auto-pan padding that accounts for whatever the panel is currently covering. */
function panPadding() {
  const panel = $('#panel');
  const rect = panel.getBoundingClientRect();
  if (isDesktop()) {
    const covered = panel.classList.contains('is-collapsed') ? 16 : Math.round(rect.right) + 24;
    return { topLeft: L.point(covered, 24), bottomRight: L.point(28, 28) };
  }
  // The extra 48px keeps the popup's action buttons clear of the sheet's top edge.
  const coveredBottom = Math.max(0, Math.round(window.innerHeight - rect.top)) + 48;
  return { topLeft: L.point(24, 24), bottomRight: L.point(28, coveredBottom) };
}

/**
 * Bounds of the dense middle of the dataset (10th-90th percentile of latitudes and
 * longitudes), not of every outlier. Fitting all 400 places frames the whole metro
 * belt - Barrackpore to Budge Budge - which parks a third of the city in one bubble
 * at zoom 9.5. The core view is where the coverage actually is; panning out still
 * reveals the edge localities, and the header states the full count.
 */
function coreBounds(features) {
  const lats = features.map((f) => f.geometry.coordinates[1]).sort((a, b) => a - b);
  const lngs = features.map((f) => f.geometry.coordinates[0]).sort((a, b) => a - b);
  const at = (arr, q) => arr[Math.floor((arr.length - 1) * q)];
  return L.latLngBounds(
    [at(lats, 0.1), at(lngs, 0.1)],
    [at(lats, 0.9), at(lngs, 0.9)]
  ).pad(0.06);
}

let popupTimer = null;

function focusFeature(f, instant) {
  const ll = latLngOf(f);
  const zoom = Math.max(map.getZoom(), 15);
  clearTimeout(popupTimer);
  if (instant) {
    map.setView(ll, zoom, { animate: false });
    openPopup(f);
    return;
  }
  map.flyTo(ll, zoom, { duration: reduceMotion ? 0 : 0.7 });
  popupTimer = setTimeout(() => openPopup(f), reduceMotion ? 30 : 720);
}

/* One popup instance for the whole map. Binding a popup to each marker instead lets
   a stale popup survive when the new one is opened from inside the asynchronous
   cluster-zoom callback, which leaves two info cards on screen at once. */
const infoPopup = L.popup({
  maxWidth: 300,
  minWidth: 250,
  closeButton: true,
  className: 'pop-wrap'
});

/* Bumped on every selection, so a cluster callback that resolves late cannot reopen
   the popup for a place the user has already moved on from. */
let popupToken = 0;

function openPopup(f) {
  const marker = state.markers.get(f.properties.id);
  if (!marker) return;

  const token = ++popupToken;
  let settled = false;
  const show = () => {
    if (settled || token !== popupToken) return;
    settled = true;
    // Padding has to be recomputed per open: the sheet may have moved since.
    const pad = panPadding();
    infoPopup.options.autoPanPaddingTopLeft = pad.topLeft;
    infoPopup.options.autoPanPaddingBottomRight = pad.bottomRight;
    infoPopup.setLatLng(latLngOf(f)).setContent(popupHtml(f));
    map.openPopup(infoPopup);
  };

  // A clustered marker is not on the map at all, so ask the cluster group to unfold
  // down to it first, then drop the popup in. The timer is the safety net: the
  // cluster callback waits on a map move that can be interrupted or, on a slow
  // device, simply take a while - and a popup that never opens looks broken.
  if (markerLayer.zoomToShowLayer && !map.hasLayer(marker)) {
    markerLayer.zoomToShowLayer(marker, show);
    clearTimeout(popupTimer);
    popupTimer = setTimeout(show, 1100);
  } else {
    show();
  }
}

function popupHtml(f) {
  const p = f.properties;
  const cat = CATS[p.category] || CATS.food;
  const st = openState(p);
  const km = state.user ? distKm(state.user, latLngOf(f)) : null;
  const coords = `${f.geometry.coordinates[1].toFixed(5)},${f.geometry.coordinates[0].toFixed(5)}`;
  const rows = [];

  rows.push(`<div class="pop__row"><b>${st.open ? 'Now' : 'Status'}</b><span>${st.label}</span></div>`);
  if (p.hours && p.hours !== st.label) {
    rows.push(`<div class="pop__row"><b>Hours</b><span>${esc(p.hours)}</span></div>`);
  }
  if (km != null) {
    rows.push(`<div class="pop__row"><b>From you</b><span>${fmtDistance(km)} straight line</span></div>`);
  }
  if (p.safety) rows.push(`<div class="pop__row"><b>Safety</b><span>${esc(p.safety)}</span></div>`);
  if (p.notes) rows.push(`<div class="pop__row pop__note">${esc(p.notes)}</div>`);

  return `<div class="pop" style="--c:${cat.color}">
    <span class="pop__cat">${cat.label}</span>
    <h3 class="pop__name">${esc(p.name)}</h3>
    <p class="pop__addr">${esc(p.address)}</p>
    <div class="pop__meta">${rows.join('')}</div>
    <div class="pop__actions">
      <a href="https://www.google.com/maps/dir/?api=1&destination=${coords}" target="_blank" rel="noopener">
        Directions
      </a>
      ${p.phone ? `<a href="tel:${esc(p.phone.replace(/\s/g, ''))}">Call</a>` : ''}
    </div>
  </div>`;
}

/* ---------------------------------------------------------------- rendering */

function isDesktop() {
  return window.matchMedia('(min-width: 1000px)').matches;
}

function matches(f) {
  const p = f.properties;
  if (state.category !== 'all' && p.category !== state.category) return false;
  if (state.openOnly && !openState(p).open) return false;
  if (state.query) {
    const hay = [p.name, p.address, p.locality, p.hours, p.notes, p.safety,
                (p.tags || []).join(' '), (CATS[p.category] || {}).label].join(' ').toLowerCase();
    if (!state.query.split(/\s+/).every((token) => hay.includes(token))) return false;
  }
  return true;
}

function computeVisible() {
  const list = state.features.filter(matches);
  if (state.sortNearest && state.user) {
    list.sort((a, b) =>
      distKm(state.user, latLngOf(a)) - distKm(state.user, latLngOf(b)));
  }
  state.visible = list;
}

function render() {
  computeVisible();
  buildMarkers();
  renderList();
  renderCount();
  renderStatusline();
  // Do not leave an info card hanging over a place the filters just removed.
  if (state.selectedId && !state.visible.some((f) => f.properties.id === state.selectedId)) {
    map.closePopup();
  }
}

function renderList() {
  const ul = $('#list');
  ul.innerHTML = '';
  state.shown = PAGE_SIZE;

  if (!state.visible.length) {
    showNotice(`<b>Nothing matches.</b><br>Filters are strict this late: try clearing
      &ldquo;open now&rdquo; or widening the category.`);
    renderCount();
    return;
  }
  hideNotice();
  appendCards(0, Math.min(state.shown, state.visible.length));
}

function bandLabel(km) {
  const band = Math.floor(km);
  return band === 0 ? 'Under 1 km' : `${band} km out`;
}

/**
 * Append cards for state.visible[from, to).
 * Paged rather than rendered in full: 400 cards is a lot of DOM for a phone, and
 * nobody scrolls past the first few dozen. "Show more" appends, so the scroll
 * position survives the tap.
 */
function appendCards(from, to) {
  const ul = $('#list');
  const existing = ul.querySelector('.more');
  if (existing) existing.remove();

  const frag = document.createDocumentFragment();

  for (let i = from; i < to; i++) {
    const f = state.visible[i];
    const p = f.properties;
    const cat = CATS[p.category] || CATS.food;
    const st = openState(p);
    const km = state.user ? distKm(state.user, latLngOf(f)) : null;

    // Distance banding: a quiet heading whenever the 1 km band changes. Compared
    // against the previous item in the full list, so bands stay correct across
    // page boundaries.
    if (km != null && state.sortNearest) {
      const prevBand = i > 0 ? Math.floor(distKm(state.user, latLngOf(state.visible[i - 1]))) : null;
      if (Math.floor(km) !== prevBand) {
        const band = document.createElement('li');
        band.className = 'band';
        band.innerHTML = `<span>${bandLabel(km)}</span>`;
        frag.appendChild(band);
      }
    }

    const li = document.createElement('li');
    li.className = 'card';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'card__hit';
    button.style.setProperty('--c', cat.color);
    button.dataset.id = p.id;
    button.setAttribute('aria-pressed', String(state.selectedId === p.id));
    button.innerHTML = `
      <span class="card__badge">${cat.icon}</span>
      <span class="card__main">
        <span class="card__top">
          <span class="card__name">${esc(p.name)}</span>
          ${km != null ? `<span class="card__dist">${fmtDistance(km)}</span>` : ''}
        </span>
        <span class="card__addr">${esc(p.address)}</span>
        <span class="card__foot">
          <span class="status status--${st.status}">${st.label}</span>
          ${p.hours && p.hours !== st.label ? `<span class="card__hours">${esc(p.hours)}</span>` : ''}
        </span>
      </span>`;
    button.addEventListener('click', () => select(p.id));
    li.appendChild(button);
    frag.appendChild(li);
  }

  ul.appendChild(frag);

  if (to < state.visible.length) {
    const li = document.createElement('li');
    li.className = 'more';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'more__btn';
    button.textContent = `Show ${Math.min(PAGE_SIZE, state.visible.length - to)} more`;
    button.addEventListener('click', () => {
      const start = state.shown;
      state.shown = Math.min(state.visible.length, state.shown + PAGE_SIZE);
      appendCards(start, state.shown);
      renderCount();
    });
    li.appendChild(button);
    ul.appendChild(li);
  }

  renderCount();
}

function renderCount() {
  const total = state.features.length;
  const hits = state.visible.length;
  const bits = [`${hits} of ${total} places`];
  if (hits > state.shown) bits.push(`showing first ${state.shown}`);
  if (state.sortNearest && state.user) bits.push('nearest first');
  $('#count').innerHTML = bits.join(' &middot; ');
}

function renderStatusline() {
  const now = new Date();
  const openCount = state.features.filter((f) => openState(f.properties, now).open).length;
  const near = state.user
    ? (state.userDistanceKm > 80 ? ' &middot; you are far from Kolkata' : ' &middot; location on')
    : '';
  $('#statusline').innerHTML =
    `<span class="mono">${fmtClock(now.getHours() * 60 + now.getMinutes())}</span> &middot; ` +
    `${openCount} of ${state.features.length} open right now${near}`;
}

/** State the size and shape of the dataset, straight from its own metadata. */
function renderCoverageNote(data) {
  const el = $('#coverage');
  if (!el) return;
  const counts = data.counts || {};
  const night = data.nightCoverage || {};
  const total = counts.total || state.features.length;
  const localities = counts.localities || night.localitiesTotal;
  const openAtNight = night.openAtReference;
  el.innerHTML = `<b>${total}</b> demo places across <b>${localities}</b> Kolkata localities` +
    (openAtNight ? ` &middot; <b>${openAtNight}</b> open at 03:30 AM, at least two in every locality` : '');
}

function showNotice(html) {
  const el = $('#notice');
  el.innerHTML = html;
  el.hidden = false;
}

function hideNotice() {
  $('#notice').hidden = true;
}

/* ---------------------------------------------------------------- selection */

function select(id, opts = {}) {
  const f = state.features.find((x) => x.properties.id === id);
  if (!f) return;

  const previous = state.selectedId;
  state.selectedId = id;

  const previousFeature = state.features.find((x) => x.properties.id === previous);
  if (previousFeature && previous !== id && state.markers.has(previous)) {
    state.markers.get(previous).setIcon(iconFor(previousFeature, false));
  }
  if (state.markers.has(id)) state.markers.get(id).setIcon(iconFor(f, true));

  document.querySelectorAll('.card__hit').forEach((btn) => {
    const on = btn.dataset.id === id;
    btn.setAttribute('aria-pressed', String(on));
    if (on && !opts.fromMarker) btn.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
  });

  focusFeature(f, opts.instant);
  if (history.replaceState) history.replaceState(null, '', `#${id}`);
}

/* ---------------------------------------------------------------- geolocation */

function locate() {
  const btn = $('#btn-locate');
  if (!('geolocation' in navigator)) {
    toast('This browser has no Geolocation API. Try Safari, Chrome or Firefox over https.');
    return;
  }
  btn.classList.add('is-busy');
  btn.disabled = true;

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      btn.classList.remove('is-busy');
      btn.disabled = false;
      const { latitude, longitude, accuracy } = pos.coords;
      state.user = { lat: latitude, lng: longitude, accuracy };
      state.userDistanceKm = distKm(state.user, KOLKATA);
      state.sortNearest = true;

      meLayer.clearLayers();
      L.circle([latitude, longitude], {
        radius: Math.max(accuracy || 0, 40),
        color: '#64B5F6', weight: 1, opacity: 0.5,
        fillColor: '#64B5F6', fillOpacity: 0.08, interactive: false
      }).addTo(meLayer);
      L.marker([latitude, longitude], {
        icon: L.divIcon({
          className: 'me',
          html: '<div class="me__dot"><span class="me__ring"></span></div>',
          iconSize: [18, 18], iconAnchor: [9, 9]
        }),
        interactive: false, keyboard: false, zIndexOffset: 1000
      }).addTo(meLayer);

      render();
      const sortBtn = $('#btn-sort');
      sortBtn.hidden = false;
      sortBtn.setAttribute('aria-pressed', 'true');
      $('#sort-label').textContent = 'Nearest first';

      if (state.userDistanceKm > 80) {
        // Do not yank the camera to another continent - the directory is Kolkata.
        toast(`Got your position, but it is about ${Math.round(state.userDistanceKm)} km from Kolkata &mdash; distances are still measured from you.`, 6000);
      } else {
        const pad = panPadding();
        const frame = state.visible.slice(0, 6).map(latLngOf);
        frame.push(L.latLng(latitude, longitude));
        map.flyToBounds(L.latLngBounds(frame), {
          paddingTopLeft: pad.topLeft,
          paddingBottomRight: pad.bottomRight,
          maxZoom: 15
        });
        toast(`Nearest first, from your position (&plusmn;${Math.round(accuracy)} m).`, 3500);
      }
    },
    (err) => {
      btn.classList.remove('is-busy');
      btn.disabled = false;
      const messages = {
        1: 'Location permission was denied. You can still browse the directory without it.',
        2: 'Your position is unavailable right now (no GPS or network fix).',
        3: 'Timed out waiting for a position fix. Try again in the open street.'
      };
      toast(`<b>Cannot sort by distance.</b><br>${messages[err.code] || 'Geolocation failed.'}`, 6000);
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
}

/* ---------------------------------------------------------------- panel (sheet / sidebar) */

const panel = $('#panel');
let peekTop = 0;
let dragging = null;

function measurePeek() {
  if (isDesktop()) { peekTop = 0; return; }
  const wasExpanded = document.body.classList.contains('is-expanded');
  panel.classList.add('is-dragging');
  document.body.classList.remove('is-expanded');
  peekTop = panel.getBoundingClientRect().top;
  if (wasExpanded) document.body.classList.add('is-expanded');
  panel.classList.remove('is-dragging');
}

function setExpanded(expanded) {
  document.body.classList.toggle('is-expanded', expanded);
  panel.classList.toggle('is-expanded', expanded);
  $('#sheet-handle').setAttribute('aria-expanded', String(expanded));
}

function setCollapsed(collapsed) {
  panel.classList.toggle('is-collapsed', collapsed);
  document.body.classList.toggle('is-panelled', collapsed);
  $('#btn-collapse').setAttribute('aria-expanded', String(!collapsed));
}

function bindDrag() {
  const handle = $('#sheet-handle');

  handle.addEventListener('pointerdown', (e) => {
    if (isDesktop()) return;
    measurePeek();
    const minTop = window.innerHeight - panel.offsetHeight;
    dragging = {
      id: e.pointerId,
      startY: e.clientY,
      startTop: panel.getBoundingClientRect().top,
      minTop,
      maxTop: peekTop,
      moved: false
    };
    panel.classList.add('is-dragging');
    document.body.classList.add('is-dragging');
    // Capture keeps the drag alive if the finger slides off the handle. Not every
    // pointer id is capturable (synthetic events, some touch engines), so bail quietly.
    try { handle.setPointerCapture(e.pointerId); } catch (err) { /* drag still works */ }
    e.preventDefault();
  });

  handle.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== dragging.id) return;
    const dy = e.clientY - dragging.startY;
    if (Math.abs(dy) > 4) dragging.moved = true;
    const top = Math.min(dragging.maxTop, Math.max(dragging.minTop, dragging.startTop + dy));
    panel.style.transform = `translateY(${top}px)`;
    // Keep the last two samples so the release can tell a flick from a slow drag.
    dragging.prev = dragging.last;
    dragging.last = { y: e.clientY, t: e.timeStamp };
  });

  const end = (e) => {
    if (!dragging || e.pointerId !== dragging.id) return;
    const dragged = dragging;
    dragging = null;
    panel.style.transform = '';
    panel.classList.remove('is-dragging');
    document.body.classList.remove('is-dragging');

    // A tap (no movement) is a plain toggle.
    if (!dragged.moved) {
      setExpanded(!document.body.classList.contains('is-expanded'));
      return;
    }

    // Snap rule, from the gesture itself rather than a layout read (a read while a
    // transition is in flight reports the old position and snaps the wrong way):
    //   1. a quick flick follows the finger's direction, 2. otherwise snap to
    //   whichever end the sheet is now closer to.
    const travel = Math.max(1, dragged.maxTop - dragged.minTop);
    const progress = (dragged.maxTop - (dragged.startTop + (e.clientY - dragged.startY))) / travel;
    let velocity = 0;
    if (dragged.prev && dragged.last && dragged.last.t > dragged.prev.t) {
      velocity = (dragged.last.y - dragged.prev.y) / (dragged.last.t - dragged.prev.t); // px per ms
    }
    // 0.5 px/ms is about 500 px/s - a deliberate swipe, not a slow drag.
    setExpanded(velocity < -0.5 ? true : velocity > 0.5 ? false : progress > 0.5);
  };

  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  // Keyboard support on the handle
  handle.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      setExpanded(!document.body.classList.contains('is-expanded'));
    }
  });
}

/* ---------------------------------------------------------------- wiring */

function bindUi() {
  document.querySelectorAll('.chip[data-cat]').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.category = chip.dataset.cat;
      document.querySelectorAll('.chip[data-cat]').forEach((c) => {
        const on = c === chip;
        c.classList.toggle('is-on', on);
        c.setAttribute('aria-pressed', String(on));
      });
      render();
    });
  });

  $('#btn-open').addEventListener('click', (e) => {
    state.openOnly = !state.openOnly;
    e.currentTarget.classList.toggle('is-on', state.openOnly);
    e.currentTarget.setAttribute('aria-pressed', String(state.openOnly));
    render();
  });

  const search = $('#search');
  const clear = $('#btn-clear');
  let searchTimer = null;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    clear.hidden = !search.value;
    searchTimer = setTimeout(() => {
      state.query = search.value.trim().toLowerCase();
      render();
    }, 140);
  });
  clear.addEventListener('click', () => {
    search.value = '';
    clear.hidden = true;
    state.query = '';
    render();
    search.focus();
  });

  $('#btn-locate').addEventListener('click', locate);

  $('#btn-sort').addEventListener('click', (e) => {
    state.sortNearest = !state.sortNearest;
    const btn = e.currentTarget;
    btn.setAttribute('aria-pressed', String(state.sortNearest));
    $('#sort-label').textContent = state.sortNearest ? 'Nearest first' : 'Default order';
    if (!state.sortNearest && !state.user) btn.hidden = true;
    render();
  });

  $('#btn-dim').addEventListener('click', (e) => {
    const on = !document.body.classList.contains('is-dimmed');
    document.body.classList.toggle('is-dimmed', on);
    e.currentTarget.setAttribute('aria-pressed', String(on));
  });

  const layerBtn = $('#btn-layers');
  const layerMenu = $('#layer-menu');
  layerBtn.addEventListener('click', () => {
    const open = layerMenu.hidden;
    layerMenu.hidden = !open;
    layerBtn.setAttribute('aria-expanded', String(open));
  });
  document.querySelectorAll('.seg').forEach((seg) => {
    seg.addEventListener('click', () => {
      setLayer(seg.dataset.layer);
      layerMenu.hidden = true;
      layerBtn.setAttribute('aria-expanded', 'false');
    });
  });
  document.addEventListener('click', (e) => {
    if (layerMenu.hidden) return;
    if (!layerMenu.contains(e.target) && !layerBtn.contains(e.target)) {
      layerMenu.hidden = true;
      layerBtn.setAttribute('aria-expanded', 'false');
    }
  });

  // Same button, two meanings: hide the sidebar on desktop, drop the sheet on phones.
  $('#btn-collapse').addEventListener('click', () => {
    if (isDesktop()) setCollapsed(true);
    else setExpanded(false);
  });
  const reopen = document.createElement('button');
  reopen.type = 'button';
  reopen.className = 'reopen';
  reopen.id = 'btn-reopen';
  reopen.title = 'Show the directory';
  reopen.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" class="ico"><path d="M9.5 6l6 6-6 6"/></svg><span class="sr-only">Show the directory</span>';
  reopen.addEventListener('click', () => setCollapsed(false));
  document.body.appendChild(reopen);

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (e.key === '/' && !typing) {
      e.preventDefault();
      setCollapsed(false);
      setExpanded(true);
      search.focus();
    }
    if (e.key === 'Escape') {
      if (!layerMenu.hidden) {
        layerMenu.hidden = true;
        layerBtn.setAttribute('aria-expanded', 'false');
        return;
      }
      if (search.value) {
        search.value = '';
        clear.hidden = true;
        state.query = '';
        render();
      } else if (!isDesktop()) {
        setExpanded(false);
      }
      map.closePopup();
    }
  });

  map.on('click', () => {
    if (!isDesktop()) setExpanded(false);
  });

  window.addEventListener('resize', () => {
    measurePeek();
    if (isDesktop()) setExpanded(false);
  });

  window.addEventListener('hashchange', () => {
    const id = location.hash.replace('#', '');
    if (id && state.features.some((f) => f.properties.id === id)) select(id, { instant: true });
  });

  // The clock keeps moving: refresh the open/closed labels when the set changes.
  setInterval(() => {
    const now = new Date();
    const signature = state.features
      .map((f) => (openState(f.properties, now).open ? '1' : '0')).join('');
    if (signature !== state.openSignature) {
      state.openSignature = signature;
      render();
    } else {
      renderStatusline();
    }
  }, 30000);
}

/* ---------------------------------------------------------------- boot */

async function boot() {
  let data;
  try {
    const res = await fetch(DATA_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    state.features = (data.features || []).filter((f) => f.geometry && f.geometry.type === 'Point');
    if (!state.features.length) throw new Error('no features');
  } catch (err) {
    $('#statusline').textContent = 'Data unavailable';
    showNotice(`<b>Could not load the locations file.</b><br>
      <span class="muted">${esc(err.message)}</span><br>
      <span class="muted">If you opened this page straight off disk (file://), the browser blocks
      reading <code>data/locations.geojson</code>. Serve it over http - GitHub Pages does this for you.</span>
      <br><button type="button" id="btn-retry">Try again</button>`);
    const retry = $('#btn-retry');
    if (retry) retry.addEventListener('click', () => location.reload());
    return;
  }

  setLayer('dark');
  renderCoverageNote(data);
  render();
  measurePeek();

  // Frame the city core, leaving room for the panel on whichever layout we are on.
  const pad = panPadding();
  map.fitBounds(coreBounds(state.features), {
    paddingTopLeft: pad.topLeft,
    paddingBottomRight: pad.bottomRight,
    maxZoom: 13
  });

  const startId = location.hash.replace('#', '');
  if (startId) select(startId, { instant: true });
}

try {
  bindUi();
  bindDrag();
  boot();
} catch (err) {
  reportError('Could not start the app', err);
}

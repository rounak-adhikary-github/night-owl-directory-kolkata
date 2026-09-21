#!/usr/bin/env node
/* =========================================================================
   Night Owl - Kolkata: fetch real place data from OpenStreetMap.

   Queries the Overpass API for the Greater Kolkata bounding box and writes
   tools/osm-source.json - a compact, normalised extract keeping only the tags
   the directory uses. This is the ONLY step that needs the network; the build
   that turns it into data/locations.geojson runs offline and reproducibly.

   Run:  node tools/fetch-osm.mjs              fetch anything not already cached
         node tools/fetch-osm.mjs --force      re-fetch every category
         node tools/fetch-osm.mjs --only food  fetch one category

   Each category is cached separately under tools/osm-raw/, so a rate-limited or
   interrupted run resumes instead of starting over. Overpass throttles hard
   (HTTP 429/504) and some mirrors lag, hence the rotation and backoff.

   Data (c) OpenStreetMap contributors, ODbL-1.0. Attribution is required and is
   shown in the app footer and on every entry that came from here.
   ========================================================================= */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RAW_DIR = path.join(HERE, 'osm-raw');
const OUT = path.join(HERE, 'osm-source.json');

/* Greater Kolkata: Budge Budge to Barrackpore, Domjur to Rajarhat. */
const BBOX = '22.28,88.05,22.92,88.62';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
  'https://overpass.osm.jp/api/interpreter'
];

const UA = 'night-owl-kolkata/1.0 (static GitHub Pages directory; dataset build)';

/*
 * One query per category, `out center;` so ways and relations get a usable
 * coordinate instead of being dropped (plenty of shops are mapped as building
 * outlines). No late-night filtering happens here on purpose - the ranking rules
 * live in build-locations.mjs where they can be read and changed in one place.
 *
 * Overpass QL note: "has no tag" is [!"key"], with the bang INSIDE the quotes.
 * The plausible-looking ["!key"] form is accepted silently and matches nothing,
 * which is a genuinely nasty way to lose a few hundred rows.
 */
/* `out center meta;` costs nothing extra and returns each element's version and
   last-edit timestamp, which the app shows as data freshness: a pharmacy record
   last touched in 2014 is worth reading with more suspicion than one from last
   month.

   Each category is a LIST of queries, all merged into one cache file. That split
   is not cosmetic: a single union over "amenity matches any of these five values"
   plus a name filter times out on every public Overpass mirror for a city this
   size (HTTP 504 after ~80 s, four mirrors in a row), while the same work split by
   amenity is served in seconds. Equality filters are also much cheaper for the
   server to evaluate than a regex, which matters when you are a guest on it. */
const queryFor = (filters, box = BBOX) =>
  `[out:json][timeout:180];\n(${filters.map((f) => `nwr${f}(${box});`).join('\n')});\nout center meta;`;

/**
 * Split the bounding box into an n x n grid and build one query per cell.
 *
 * Not premature optimisation: the single city-wide query for named eateries
 * returned HTTP 504 on every public mirror (they give up after ~80 s), while the
 * same work as sixteen small cells comes back in seconds. The mirrors are a shared
 * free resource, so the polite thing and the fast thing happen to be the same thing.
 */
function grid(partFn, n = 4) {
  const [south, west, north, east] = BBOX.split(',').map(Number);
  const dLat = (north - south) / n;
  const dLon = (east - west) / n;
  const queries = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const box = [
        south + i * dLat, west + j * dLon,
        south + (i + 1) * dLat, west + (j + 1) * dLon
      ].map((v) => v.toFixed(4)).join(',');
      queries.push(partFn(box));
    }
  }
  return queries;
}

const QUERIES = {
  pharmacy: [
    queryFor([
      '["amenity"="pharmacy"]', '["shop"="chemist"]', '["healthcare"="pharmacy"]',
      '["shop"="medical_supply"]'
    ])
  ],

  /* Hospitals and nursing homes. All of them, named or not: the build decides
     which ones are a night resource, so the raw pool is kept complete here. In
     this city the tag also covers eye clinics, dental surgeries and fertility
     centres, which the build filters out by name. */
  hospital: [
    queryFor(['["amenity"="hospital"]', '["healthcare"="hospital"]'])
  ],

  fuel: [
    queryFor(['["amenity"="fuel"]']),
    queryFor(['["shop"="car_repair"]["opening_hours"]', '["shop"="tyres"]["opening_hours"]'])
  ],

  /* Every eatery the city has mapped, hours or not, named or not. In this city
     the roll counters, biryani joints and chai stalls that carry the night are
     almost never tagged with opening times, so requiring hours would throw away
     most of the real food coverage; and a good share of them are mapped without a
     name, which is a placeholder for a real stall on a real street corner. Both
     ship flagged (hours not listed / name not mapped) and the build sorts out how
     much of that uncertainty the map can carry. Bakeries are pulled in because
     they are the one food category in Kolkata that reliably opens at dawn and
     still sells at 1 AM. */
  food: grid((box) => queryFor([
    '["amenity"="restaurant"]',
    '["amenity"="fast_food"]',
    '["amenity"="cafe"]',
    '["amenity"="ice_cream"]',
    '["amenity"="food_court"]',
    '["shop"="bakery"]',
    '["shop"="confectionery"]',
    '["amenity"="canteen"]["name"]',
    '["amenity"="bar"]["name"]',
    '["amenity"="pub"]["name"]'
  ], box)),

  /* Real transport infrastructure: metro stations, suburban rail stations (the
     backbone of a late-night journey home), bus terminuses, taxi ranks, ferry
     ghats. Individual bus stops are excluded - at 3:30 AM an unlit kerbside pole
     is not a safe pickup spot, and half a thousand of them would swamp the map. */
  transit: [
    queryFor([
      '["station"="subway"]', '["railway"="station"]', '["railway"="halt"]',
      '["amenity"="bus_station"]', '["amenity"="taxi"]', '["amenity"="ferry_terminal"]'
    ])
  ]
};

/* Tags worth keeping. Everything else is dropped to keep the repo small. */
const KEEP = [
  'name', 'name:en', 'opening_hours', 'amenity', 'shop', 'railway', 'station',
  'highway', 'public_transport', 'addr:housenumber', 'addr:street', 'addr:suburb',
  'addr:city', 'operator', 'brand', 'network', 'emergency', 'dispensing', 'healthcare',
  'cuisine', 'wheelchair', 'level', 'line', 'ref', 'operator:type', 'description'
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function overpass(query, label) {
  let lastError = 'no attempt made';
  for (let attempt = 0; attempt < 10; attempt++) {
    for (const endpoint of ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'User-Agent': UA, 'Content-Type': 'text/plain;charset=UTF-8' },
          body: query,
          signal: AbortSignal.timeout(150000)
        });
        if (res.status === 429 || res.status === 504 || res.status === 502 || res.status === 509) {
          lastError = `${endpoint} -> HTTP ${res.status}`;
          console.log(`    busy (${res.status}) at ${new URL(endpoint).host}, trying next`);
          continue;   // rate limited or overloaded: rotate to another mirror
        }
        if (!res.ok) {
          lastError = `${endpoint} -> HTTP ${res.status} ${res.statusText}`;
          continue;
        }
        const json = await res.json();
        if (json.remark) {
          // Overpass reports quota and timeout problems in a 200 response body.
          lastError = `Overpass remark: ${json.remark}`;
          console.log(`    remark: ${json.remark.slice(0, 120)}`);
          continue;
        }
        return json;
      } catch (err) {
        lastError = `${new URL(endpoint).host}: ${err.message}`;
      }
      await sleep(1000);
    }
    const wait = Math.min(45000, 6000 * (attempt + 1));
    console.log(`    all mirrors busy, waiting ${Math.round(wait / 1000)}s (attempt ${attempt + 1}/10)`);
    await sleep(wait);
  }
  throw new Error(`Overpass failed for ${label}: ${lastError}`);
}

function normalise(element, category) {
  const tags = element.tags || {};
  const lat = element.lat !== undefined ? element.lat : element.center && element.center.lat;
  const lon = element.lon !== undefined ? element.lon : element.center && element.center.lon;
  if (lat === undefined || lon === undefined) return null;

  const kept = {};
  for (const key of KEEP) {
    if (tags[key] !== undefined && tags[key] !== '') kept[key] = String(tags[key]).slice(0, 200);
  }

  return {
    id: `${element.type}/${element.id}`,
    lat: +lat.toFixed(6),
    lon: +lon.toFixed(6),
    tags: kept,
    /* From `out center meta`: when a mapper last touched this record. */
    edited: element.timestamp ? element.timestamp.slice(0, 10) : null,
    version: element.version || null,
    queryCategory: category
  };
}

async function fetchCategory(category, queries) {
  const cache = path.join(RAW_DIR, `${category}.json`);
  console.log(`${category.padEnd(9)} ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}...`);

  const rows = [];
  let returned = 0;
  let timestamp = null;
  let emptyParts = 0;
  const single = queries.length === 1;

  for (let i = 0; i < queries.length; i++) {
    const label = `${category} part ${i + 1}`;
    let json = await overpass(queries[i], label);
    let elements = json.elements || [];

    /* A mirror under load answers 200 with an empty element list, and from the
       outside that is indistinguishable from a cell that genuinely holds nothing
       (the rural south-west corner of the bounding box does). Ask the same cell for
       a count: it is a tiny query, and it settles the question before an empty
       result gets written into the cache as fact. */
    if (!elements.length) {
      const countQuery = queries[i].replace(/out center meta;\s*$/, 'out count;');
      const probe = await overpass(countQuery, `${label} (count check)`);
      const total = Number((probe.elements && probe.elements[0] && probe.elements[0].tags &&
        probe.elements[0].tags.total) || 0);
      if (total > 0) {
        console.log(`          cell holds ${total} elements but came back empty - refetching`);
        await sleep(4000);
        json = await overpass(queries[i], `${label} (retry)`);
        elements = json.elements || [];
        if (!elements.length) {
          console.log(`          still empty on retry: ${total} elements left out`);
        }
      } else {
        console.log('          count confirms this cell is genuinely empty');
      }
    }

    if (!elements.length) emptyParts++;

    returned += elements.length;
    rows.push(...elements.map((el) => normalise(el, category)).filter(Boolean));
    timestamp = (json.osm3s && json.osm3s.timestamp_osm_base) || timestamp;
    console.log(`${''.padEnd(9)} part ${i + 1}/${queries.length}: ${elements.length} returned`);
    if (i < queries.length - 1) await sleep(5000);   // breathe between parts
  }

  // An empty 200 means a mirror gave up rather than that Kolkata has nothing. A
  // single grid cell can genuinely be empty (the rural south-west corner is), but
  // if most of them are, it is the mirror, and caching that would poison every
  // later build - so refuse to write it and let the next run try again.
  if (returned === 0 || (single && returned === 0) || (!single && emptyParts > queries.length / 2)) {
    throw new Error(
      `${category}: ${emptyParts}/${queries.length} parts came back empty ` +
      `(${returned} elements total) - mirror problem, not cached`
    );
  }

  // Ways and relations come back through `out center`; a few landmarks are also
  // mapped twice (a node inside a way), so collapse near-identical entries.
  const seenId = new Set();
  const seenPlace = new Set();
  const unique = rows.filter((row) => {
    if (seenId.has(row.id)) return false;                    // grid cells overlap at edges
    seenId.add(row.id);
    const place = `${row.tags.name}|${row.lat.toFixed(4)}|${row.lon.toFixed(4)}`;
    if (seenPlace.has(place)) return false;                  // node inside way, mapped twice
    seenPlace.add(place);
    return true;
  });

  const payload = {
    category,
    queries: queries.map((q) => q.trim()),
    timestamp,
    elementsReturned: returned,
    elementsKept: unique.length,
    elements: unique
  };
  fs.writeFileSync(cache, JSON.stringify(payload, null, 1) + '\n');
  console.log(`${''.padEnd(9)} ${unique.length} places kept of ${returned} returned`);
  return payload;
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const only = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1];

  fs.mkdirSync(RAW_DIR, { recursive: true });

  const categories = only ? { [only]: QUERIES[only] } : QUERIES;
  if (only && !QUERIES[only]) throw new Error(`unknown category "${only}"`);

  for (const [category, queries] of Object.entries(categories)) {
    const cache = path.join(RAW_DIR, `${category}.json`);
    const cached = fs.existsSync(cache) ? JSON.parse(fs.readFileSync(cache, 'utf8')) : null;
    // An empty cache file is a failed fetch that got written anyway - refetch it.
    if (!force && cached && cached.elementsKept > 0) {
      console.log(`${category.padEnd(9)} cached: ${cached.elementsKept} places`);
      continue;
    }
    await fetchCategory(category, queries);
    await sleep(6000);   // be a good citizen between categories
  }

  // Re-read every cache so a --only run still emits the complete source file.
  const all = {};
  let elements = [];
  for (const category of Object.keys(QUERIES)) {
    const cache = path.join(RAW_DIR, `${category}.json`);
    if (!fs.existsSync(cache)) continue;
    const payload = JSON.parse(fs.readFileSync(cache, 'utf8'));
    all[category] = {
      elementsReturned: payload.elementsReturned,
      elementsKept: payload.elementsKept,
      timestamp: payload.timestamp,
      queries: payload.queries
    };
    elements = elements.concat(payload.elements);
  }

  // The same place can arrive from two categories (a hospital dispensary that is
  // also tagged a pharmacy); the first category in QUERIES order wins.
  const seen = new Set();
  const unique = elements.filter((el) => {
    if (seen.has(el.id)) return false;
    seen.add(el.id);
    return true;
  });

  const out = {
    source: 'OpenStreetMap via the Overpass API',
    sourceUrl: 'https://www.openstreetmap.org/',
    license: 'ODbL-1.0',
    attribution: '© OpenStreetMap contributors',
    fetched: new Date().toISOString().slice(0, 10),
    bbox: BBOX.split(',').map(Number),
    note:
      'Compact normalised extract: only the tags the directory uses are kept, the full ' +
      'element data is discarded. Re-fetch with: node tools/fetch-osm.mjs --force',
    queries: all,
    counts: {
      elements: unique.length,
      withHours: unique.filter((e) => e.tags.opening_hours).length,
      byCategory: Object.fromEntries(
        Object.keys(QUERIES).map((c) => [c, unique.filter((e) => e.queryCategory === c).length])
      )
    },
    elements: unique
  };

  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`\nwrote ${path.relative(process.cwd(), OUT)}`);
  console.log(`${unique.length} places, ${out.counts.withHours} with opening hours, ${kb} KB`);
  console.log(out.counts.byCategory);
}

main().catch((err) => {
  console.error('\nfetch failed:', err.message);
  process.exit(1);
});

#!/usr/bin/env node
/* =========================================================================
   Night Owl - Kolkata: fetch real place data from OpenStreetMap.

   Queries the Overpass API for the Greater Kolkata bounding box and writes
   tools/osm-source.json - a compact, normalised extract that keeps the tags the
   directory actually uses. This is the ONLY step that needs the network; the
   build that turns it into data/locations.geojson runs offline and reproducibly.

   Run:  node tools/fetch-osm.mjs

   Data (c) OpenStreetMap contributors, ODbL-1.0. Attribution is required and is
   shown in the app footer and in the popup for every entry that came from here.
   ========================================================================= */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'osm-source.json');

/* Greater Kolkata: Budge Budge to Barrackpore, Domjur to Rajarhat. */
const BBOX = '22.28,88.05,22.92,88.62';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.jp/api/interpreter'
];

const UA = 'night-owl-kolkata/1.0 (static GitHub Pages directory; dataset build)';

/*
 * One query per category. `out center;` gives ways and relations a usable
 * coordinate instead of dropping them, which matters because plenty of shops are
 * mapped as building outlines rather than points.
 *
 * No late-night filtering happens here on purpose: the ranking rules live in
 * build-locations.mjs where they can be read, tested and changed in one place.
 */
const QUERIES = {
  pharmacy: `
    [out:json][timeout:180];
    (
      nwr["amenity"="pharmacy"](${BBOX});
      nwr["shop"="chemist"](${BBOX});
      nwr["healthcare"="pharmacy"](${BBOX});
    );
    out center;`,

  /* Hospitals are the most dependable 3 AM resource in the city: a 24-hour
     emergency department dispenses the medicines a chemist would. Only ones that
     actually declare an emergency department are kept by the build. */
  hospital: `
    [out:json][timeout:180];
    (
      nwr["amenity"="hospital"](${BBOX});
      nwr["healthcare"="hospital"](${BBOX});
    );
    out center;`,

  fuel: `
    [out:json][timeout:180];
    (
      nwr["amenity"="fuel"](${BBOX});
      nwr["shop"="car_repair"]["opening_hours"](${BBOX});
      nwr["shop"="tyres"]["opening_hours"](${BBOX});
    );
    out center;`,

  /* Eateries with mapped hours. The build keeps the ones that run into the night
     and drops ones that provably shut by early evening. */
  food: `
    [out:json][timeout:240];
    (
      nwr["amenity"="restaurant"]["opening_hours"](${BBOX});
      nwr["amenity"="fast_food"]["opening_hours"](${BBOX});
      nwr["amenity"="cafe"]["opening_hours"](${BBOX});
      nwr["amenity"="ice_cream"]["opening_hours"](${BBOX});
      nwr["amenity"="food_court"]["opening_hours"](${BBOX});
    );
    out center;`,

  /* The same eateries without hours, because in this city the roll counters,
     biryani joints and chai stalls that carry the night are almost never tagged
     with opening times. These ship flagged "hours not listed" rather than
     silently dropped - the app shows the distinction and the Open-now filter
     ignores them. */
  foodUntagged: `
    [out:json][timeout:300];
    (
      nwr["amenity"="restaurant"]["name"]["!opening_hours"](${BBOX});
      nwr["amenity"="fast_food"]["name"]["!opening_hours"](${BBOX});
      nwr["amenity"="cafe"]["name"]["!opening_hours"](${BBOX});
      nwr["amenity"="ice_cream"]["name"]["!opening_hours"](${BBOX});
      nwr["amenity"="food_court"]["name"]["!opening_hours"](${BBOX});
    );
    out center;`,

  /* Real transport infrastructure: metro stations, suburban rail stations (the
     backbone of a late-night journey home), bus terminuses, taxi ranks, ferry
     ghats. Individual bus stops are excluded - at 3:30 AM an unlit kerbside pole
     is not a safe pickup spot, and half a thousand of them would swamp the map. */
  transit: `
    [out:json][timeout:180];
    (
      nwr["station"="subway"](${BBOX});
      nwr["railway"="station"](${BBOX});
      nwr["railway"="halt"](${BBOX});
      nwr["amenity"="bus_station"](${BBOX});
      nwr["amenity"="taxi"](${BBOX});
      nwr["amenity"="ferry_terminal"](${BBOX});
    );
    out center;`
};

/* Tags worth keeping. Everything else is dropped to keep the repo small. */
const KEEP = [
  'name', 'name:en', 'name:bn', 'opening_hours', 'amenity', 'shop', 'railway', 'station',
  'highway', 'public_transport', 'addr:housenumber', 'addr:street', 'addr:suburb',
  'addr:city', 'operator', 'brand', 'network', 'emergency', 'dispensing', 'healthcare',
  'building', 'line', 'ref', 'cuisine', 'wheelchair', 'phone', 'contact:phone', 'level',
  'operator:type', 'railway:station_category', 'dispensary'
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function overpass(query) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const endpoint of ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'User-Agent': UA, 'Content-Type': 'text/plain;charset=UTF-8' },
          body: query,
          signal: AbortSignal.timeout(300000)
        });
        if (res.status === 429 || res.status === 504 || res.status === 502) {
          lastError = new Error(`${endpoint} -> HTTP ${res.status}`);
          continue;   // busy mirror or rate limit; try the next one
        }
        if (!res.ok) throw new Error(`${endpoint} -> HTTP ${res.status} ${res.statusText}`);
        return await res.json();
      } catch (err) {
        lastError = err;
      }
      await sleep(1500);
    }
    await sleep(4000 * (attempt + 1));
  }
  throw new Error(`Overpass failed for all endpoints: ${lastError && lastError.message}`);
}

function normalise(element) {
  const tags = element.tags || {};
  const lat = element.lat !== undefined ? element.lat : element.center && element.center.lat;
  const lon = element.lon !== undefined ? element.lon : element.center && element.center.lon;
  if (lat === undefined || lon === undefined) return null;

  const kept = {};
  for (const key of KEEP) {
    if (tags[key] !== undefined && tags[key] !== '') kept[key] = String(tags[key]).slice(0, 160);
  }

  return {
    id: `${element.type}/${element.id}`,
    lat: +lat.toFixed(6),
    lon: +lon.toFixed(6),
    tags: kept
  };
}

async function main() {
  const elements = [];
  const meta = {};
  let rawCount = 0;

  for (const [category, query] of Object.entries(QUERIES)) {
    process.stdout.write(`${category.padEnd(12)} querying Overpass... `);
    const json = await overpass(query);
    const rows = (json.elements || []).map(normalise).filter(Boolean);
    rawCount += json.elements.length;
    elements.push(...rows.map((row) => ({ ...row, queryCategory: category })));
    meta[category] = {
      elementsReturned: json.elements.length,
      elementsWithCoordinates: rows.length,
      timestamp: (json.osm3s && json.osm3s.timestamp_osm_base) || null,
      query: query.trim()
    };
    console.log(`${rows.length} usable of ${json.elements.length}`);
    await sleep(1200);   // be a good citizen between queries
  }

  // The same place can come back from two queries (a chemist that is also a
  // hospital dispensary, an eatery in both food queries); keep the first.
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
      'element data is discarded. Re-fetch with: node tools/fetch-osm.mjs',
    queries: meta,
    counts: { rawElements: rawCount, normalised: unique.length },
    elements: unique
  };

  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`\nwrote ${path.relative(process.cwd(), OUT)} - ${unique.length} places, ${kb} KB`);
  console.log('with opening_hours:', unique.filter((e) => e.tags.opening_hours).length);
}

main().catch((err) => {
  console.error('\nfetch failed:', err.message);
  process.exit(1);
});

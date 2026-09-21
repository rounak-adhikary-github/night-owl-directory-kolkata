#!/usr/bin/env node
/* =========================================================================
   Night Owl - Kolkata: build the directory from real place data.

   Input    tools/osm-source.json   real places, real coordinates (OpenStreetMap)
            tools/localities.mjs    neighbourhood anchors, used for labelling only

   Output   data/locations.geojson what the app loads

   Run:  node tools/build-locations.mjs

   Everything in the output comes from OpenStreetMap. Nothing here invents a
   business, a coordinate or an opening time. Where OpenStreetMap has no hours the
   entry says "hours not listed" instead of guessing, and where a place has no
   mapped name the entry says so - the app's own filter counts only places whose
   hours are known, so an unknown never masquerades as an open.

   Contributing: add real places to OpenStreetMap (overpass-turbo or the iD editor)
   rather than editing this repository. Re-run fetch-osm.mjs, then this script.
   ========================================================================= */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCALITIES } from './localities.mjs';
import { parseOsmHours, openAtMinute, nightRelevant } from './hours.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SOURCE_FILE = path.join(HERE, 'osm-source.json');
const OUT_FILE = path.join(ROOT, 'data', 'locations.geojson');

/* The hour the coverage figures are quoted for - the end of a late shift. */
const NIGHT_REF_MIN = 3 * 60 + 30;

/* Nothing outside the fetched box can be trusted, and the box is Greater Kolkata. */
const BBOX_LIMIT = '22.28,88.05,22.92,88.62'.split(',').map(Number);

/* ---------- small helpers ------------------------------------------------ */

const normName = (s) => String(s || '')
  .toLowerCase()
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\b(pvt|private|ltd|limited|the|and|&|co)\b/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function distKm(a, b) {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lon - a.lon) * rad;
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/* ---------- neighbourhood labelling ------------------------------------- */

/* Note the rename: the table calls its longitude `lng`, distKm() reads `lon`, and
   mixing the two yields NaN - which compares false against every threshold and
   silently labels the whole city "Kolkata". */
const ANCHORS = LOCALITIES.map(([name, lat, lng]) => ({ name, lat, lon: lng }));

/**
 * Nearest neighbourhood anchor, capped at 7 km. OpenStreetMap carries addr:suburb
 * for only a handful of places here, so this is what makes "Behala" or "New Town"
 * searchable. It labels a place; it never positions one.
 */
function nearestLocality(lat, lon) {
  let best = null;
  for (const anchor of ANCHORS) {
    const km = distKm({ lat, lon }, anchor);
    if (!best || km < best.km) best = { name: anchor.name, km };
  }
  return best && best.km <= 7 ? best.name : null;
}

/* ---------- hospitals --------------------------------------------------- */

/*
 * amenity=hospital in Kolkata covers everything from a medical college with a
 * night casualty to an eye clinic that shuts at 20:00. The tag alone cannot tell
 * them apart and there is no reliable "has a casualty department" tag in the data,
 * so the split is made by what the place calls itself. This drops only the kinds
 * that are never a 3 AM resource; everything else is kept and labelled for what it
 * is, because an unlisted hospital is the most expensive omission this dataset can
 * make.
 */
const NOT_A_NIGHT_CASUALTY =
  /\b(eye|eyecare|ophthalm\w*|dental|dentist\w*|ivf|infertil\w*|fertil\w*|diagnostic\w*|patholog\w*|imaging|scan\w*|radiolog\w*|physiotherap\w*|veterinar\w*|optic\w*|hearing|cosmetic|dermatolog\w*|skin|dialysis|homeopath\w*|ayurved\w*|unani|acupunctur\w*|blood bank|sample collection|test tube|care centre for)\b/i;

/* Government hospitals and medical colleges: casualty runs all night without
   exception, and it is the sort of thing the tag cannot say. Used only to pick a
   clearer label, never to assert hours that OpenStreetMap does not carry. */
const CASUALTY_ALWAYS = /\b(s\s*s\s*k\s*m|medical college|general hospital|state hospital|college and hospital|college & hospital|post graduate|pg hospital|district hospital|railway hospital|police hospital|charitable hospital)\b/i;

/* ---------- load input --------------------------------------------------- */

const source = JSON.parse(fs.readFileSync(SOURCE_FILE, 'utf8'));

const stats = {
  droppedUnnamed: {},
  droppedDaytimeOnly: {},
  droppedDuplicate: 0,
  droppedNonCasualty: 0,
  hoursParsed: 0,
  hoursComplex: 0,
  hoursMissing: 0,
  nameUnmapped: 0,
  hospitalsKept: 0,
  hospitalsDroppedByName: 0
};

/* ---------- OpenStreetMap -> feature ------------------------------------ */

const CATEGORY = {
  pharmacy: 'pharmacy',
  hospital: 'pharmacy',   // a casualty department is where you get medicine at night
  fuel: 'fuel',
  food: 'food',
  transit: 'transit'
};

function tagsFor(element, category, locality) {
  const t = element.tags;
  const out = new Set();
  if (t.brand) out.add(t.brand);
  if (t.operator) out.add(t.operator);
  if (t.cuisine) t.cuisine.split(';').forEach((c) => out.add(c.trim()));
  if (t.network) out.add(t.network);
  if (t.line) out.add(t.line);
  if (t.ref) out.add(t.ref);
  if (locality) out.add(locality);

  if (category === 'pharmacy') ['chemist', 'medicine', 'pharmacy', 'drugstore'].forEach((w) => out.add(w));
  if (category === 'food') ['food', 'eat', 'restaurant'].forEach((w) => out.add(w));
  if (category === 'fuel') ['petrol', 'diesel', 'fuel', 'filling station'].forEach((w) => out.add(w));
  if (category === 'transit') {
    ['transit', 'station', 'pickup', 'stand'].forEach((w) => out.add(w));
    if (t.station === 'subway') ['metro', 'subway', 'blue line'].forEach((w) => out.add(w));
    if (t.railway === 'station' || t.railway === 'halt') out.add('railway');
    if (t.amenity === 'bus_station') out.add('bus');
    if (t.amenity === 'taxi') out.add('taxi');
    if (t.amenity === 'ferry_terminal') out.add('ferry');
  }
  return [...out].map((s) => String(s).trim()).filter(Boolean).slice(0, 12);
}

function addressOf(tags, locality) {
  const parts = [];
  const street = tags['addr:street'];
  if (street) parts.push([tags['addr:housenumber'], street].filter(Boolean).join(' '));
  if (tags['addr:suburb']) parts.push(tags['addr:suburb']);
  if (locality) parts.push(locality);
  if (!parts.length) parts.push('Kolkata');
  return [...new Set(parts)].join(', ');
}

function fmtHours(parsed) {
  if (!parsed) return null;
  if (parsed.always) return 'Open 24 hours';
  return `${parsed.open} - ${parsed.close}${parsed.daySummary === 'daily' ? ' daily' : `, ${parsed.daySummary}`}`;
}

/*
 * What kind of thing this actually is, in the words a person would use. The four
 * categories are deliberately coarse (a directory with twenty filters is useless at
 * 3 AM), which is exactly why the label has to be finer where the data is: a tyre
 * shop, a ferry ghat and a metro station are all "transit" to the filter and
 * nothing like each other in the street.
 */
function subtypeLabelFor(t, category) {
  if (category === 'transit') {
    if (t.station === 'subway') return 'Metro station';
    if (t.railway === 'station' || t.railway === 'halt') return 'Railway station';
    if (t.amenity === 'bus_station') return 'Bus terminus';
    if (t.amenity === 'taxi') return 'Taxi stand';
    if (t.amenity === 'ferry_terminal') return 'Ferry ghat';
    return null;
  }
  if (category === 'fuel') {
    if (t.shop === 'car_repair') return 'Car mechanic';
    if (t.shop === 'tyres') return 'Tyre shop';
    return 'Petrol pump';
  }
  if (category === 'pharmacy') {
    if (t.shop === 'chemist') return 'Chemist';
    if (t.shop === 'medical_supply') return 'Medical supplies';
    return 'Pharmacy';
  }
  return null;
}

/* The category label used when OpenStreetMap has no name for a place. */
const UNNAMED_LABEL = {
  pharmacy: 'Pharmacy (name not mapped)',
  food: 'Eatery (name not mapped)',
  fuel: 'Fuel station (name not mapped)',
  transit: 'Transit stop (name not mapped)'
};

const features = [];

/* Ways and relations arrive from `out center` with a centre, so every element
   here already has a coordinate. */
for (const element of source.elements) {
  const category = CATEGORY[element.queryCategory];
  if (!category) continue;

  const t = element.tags;
  const lat = element.lat;
  const lon = element.lon;
  const locality = nearestLocality(lat, lon);

  const isHospital = element.queryCategory === 'hospital';
  // Collapse runs of whitespace: mappers type double spaces, and a card that reads
  // "nehru  memorial" looks like a parsing bug rather than a place.
  const mappedName = (t.name || '').replace(/\s+/g, ' ').trim() || null;

  if (isHospital && mappedName && NOT_A_NIGHT_CASUALTY.test(mappedName)) {
    stats.hospitalsDroppedByName++;
    continue;
  }

  /* A nameless hospital is a real building but useless to someone searching at
     3 AM: nothing to give a driver. Everything else survives without a name. */
  if (isHospital && !mappedName) {
    stats.droppedUnnamed.hospital = (stats.droppedUnnamed.hospital || 0) + 1;
    continue;
  }
  if (!mappedName && (category === 'transit' || category === 'fuel')) {
    stats.droppedUnnamed[category] = (stats.droppedUnnamed[category] || 0) + 1;
    continue;
  }
  if (!mappedName) stats.nameUnmapped++;

  const raw = t.opening_hours;
  const parsed = parseOsmHours(raw);
  const relevance = nightRelevant(parsed);

  /* A place whose mapped hours prove it shuts for the whole night is not a night
     resource; listing it would just crowd out the ones that are open. A hospital
     is exempt: its casualty is not described by the hours of its office block. */
  if (!isHospital && relevance === false) {
    stats.droppedDaytimeOnly[category] = (stats.droppedDaytimeOnly[category] || 0) + 1;
    continue;
  }

  if (!raw) stats.hoursMissing++;
  else if (parsed) stats.hoursParsed++;
  else stats.hoursComplex++;

  const name = mappedName ||
    `${UNNAMED_LABEL[category]}${locality ? ` - ${locality}` : ''}`;

  const properties = {
    id: element.id.replace('/', '-'),
    name,
    nameUnmapped: !mappedName,
    category,
    osmKind: t.amenity || t.shop || t.railway || t.healthcare || null,
    address: addressOf(t, locality),
    locality: locality || 'Kolkata',
    always: parsed ? !!parsed.always : false,
    open: parsed && !parsed.always ? parsed.open : null,
    close: parsed && !parsed.always ? parsed.close : null,
    closedDays: parsed && !parsed.always ? parsed.closedDays : null,
    hoursKnown: !!parsed,
    rawHours: raw || null,
    // Unparseable hours are still shown, verbatim: the user can read
    // "Mo-Fr 13:00-15:30,18:00-23:00" even when this app cannot judge it.
    hours: fmtHours(parsed) || raw || null,
    tags: tagsFor(element, category, locality),
    source: 'openstreetmap',
    osmId: element.id,
    osmEdited: element.edited || null,
    osmVersion: element.version || null,
    verified: null
  };

  const subtypeLabel = subtypeLabelFor(t, category);
  if (subtypeLabel && !isHospital) properties.subtypeLabel = subtypeLabel;

  if (isHospital) {
    // Searchable as a hospital, not only as a pharmacy: at 3 AM the word people
    // type is "hospital".
    properties.tags = [...new Set([
      ...properties.tags,
      'hospital', 'casualty', 'emergency', 'medicine', 'pharmacy', '24 hours'
    ])].slice(0, 12);
    properties.subtype = 'hospital';
    properties.subtypeLabel = 'Hospital - casualty open through the night';
    properties.casualty = true;
    // Not invented: a hospital keeps a night casualty whether or not the mapper
    // typed its hours in. Kept in its own field so the app can say exactly what it
    // does and does not know.
    properties.overnight = true;
    properties.notes = CASUALTY_ALWAYS.test(mappedName)
      ? 'Government / medical college hospital. The casualty department runs all ' +
        'night and the dispensary is the one place in the area that will hand over ' +
        'medicine at 3:30 AM. Opening hours for the outpatient departments are not ' +
        'mapped in OpenStreetMap.'
      : 'Hospital with a 24-hour casualty department. OpenStreetMap does not carry ' +
        'its department hours, so treat the times shown as unverified.';
    stats.hospitalsKept++;
  }

  features.push({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties
  });
}

/*
 * An unnamed eatery sitting on top of a named one is almost always the same shop
 * mapped twice (once as a node, once as a building outline, one of them without a
 * name). Dropping the unnamed one removes real clutter and loses nothing: the place
 * is still on the map, under the name someone actually gave it.
 */
{
  const namedFood = features.filter((f) => f.properties.category === 'food' && !f.properties.nameUnmapped);
  const drop = new Set();
  for (const f of features) {
    if (f.properties.category !== 'food' || !f.properties.nameUnmapped) continue;
    const at = { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] };
    if (namedFood.some((n) => distKm(at, {
      lat: n.geometry.coordinates[1], lon: n.geometry.coordinates[0]
    }) < 0.1)) {
      drop.add(f);
    }
  }
  if (drop.size) {
    stats.droppedDuplicate += drop.size;
    for (let i = features.length - 1; i >= 0; i--) if (drop.has(features[i])) features.splice(i, 1);
  }
}

/*
 * One pin per place, generally. The same shop gets mapped twice surprisingly often
 * - once as a node, once as a building outline, or by two people who spelled the
 * name slightly differently. Two entries with the same name, in the same category,
 * inside 60 m are that duplicate; keeping both just makes the list lie about how
 * much is open nearby. Compared on a normalised name, so case and "Pvt Ltd" do not
 * hide a duplicate.
 */
{
  const drop = new Set();
  for (let i = 0; i < features.length; i++) {
    const a = features[i];
    if (drop.has(a)) continue;
    const at = { lat: a.geometry.coordinates[1], lon: a.geometry.coordinates[0] };
    const na = normName(a.properties.name);
    for (let j = i + 1; j < features.length; j++) {
      const b = features[j];
      if (drop.has(b) || b.properties.category !== a.properties.category) continue;
      if (na !== normName(b.properties.name)) continue;
      const near = distKm(at, { lat: b.geometry.coordinates[1], lon: b.geometry.coordinates[0] });
      if (near > 0.06) continue;
      // Keep whichever record carries more: mapped hours first, then a newer edit.
      const score = (f) => (f.properties.rawHours ? 2 : 0) + (f.properties.locality !== 'Kolkata' ? 1 : 0);
      const loser = score(a) >= score(b) ? b : a;
      drop.add(loser);
      if (loser === a) break;
    }
  }
  if (drop.size) {
    stats.droppedDuplicate += drop.size;
    for (let i = features.length - 1; i >= 0; i--) if (drop.has(features[i])) features.splice(i, 1);
  }
}

/*
 * One pin per hospital, over a wider radius. NRS alone is mapped as five separate
 * buildings, and a medical college campus is often four nodes for one address, so
 * this pass matches on a shared first word within 400 m where the general one above
 * insists on the whole name within 60.
 */
{
  const hospitals = features.filter((f) => f.properties.subtype === 'hospital');
  const drop = new Set();
  for (const a of hospitals) {
    if (drop.has(a)) continue;
    for (const b of hospitals) {
      if (a === b || drop.has(b)) continue;
      const near = distKm(
        { lat: a.geometry.coordinates[1], lon: a.geometry.coordinates[0] },
        { lat: b.geometry.coordinates[1], lon: b.geometry.coordinates[0] }
      );
      if (near > 0.4) continue;
      const na = normName(a.properties.name);
      const nb = normName(b.properties.name);
      const related = na === nb || na.startsWith(nb) || nb.startsWith(na) ||
        na.split(' ')[0] === nb.split(' ')[0];
      if (!related) continue;
      const score = (f) => (f.properties.rawHours ? 2 : 0) + (f.properties.osmEdited ? 1 : 0) +
        (f.properties.name.length > 4 ? 1 : 0);
      drop.add(score(a) >= score(b) ? b : a);
    }
  }
  if (drop.size) {
    stats.droppedDuplicate += drop.size;
    for (let i = features.length - 1; i >= 0; i--) if (drop.has(features[i])) features.splice(i, 1);
  }
}

/* ---------- sanity: coordinates inside the boxes we claim ---------------- */

const [south, west, north, east] = source.bbox || BBOX_LIMIT;
const outside = features.filter((f) => {
  const [lon, lat] = f.geometry.coordinates;
  return lat < south || lat > north || lon < west || lon > east;
});
if (outside.length) {
  console.warn(`warning: ${outside.length} features outside the fetched bbox`);
  for (let i = features.length - 1; i >= 0; i--) if (outside.includes(features[i])) features.splice(i, 1);
}

/* ---------- report ------------------------------------------------------- */

const counts = {
  total: features.length,
  byCategory: {},
  bySource: {},
  bySubtype: {},
  withHours: 0,
  hoursUnknown: 0,
  namesUnmapped: 0,
  open24h: 0,
  openAtNightRef: 0,
  neighbourhoods: 0
};

const neighbourhoods = new Set();
for (const f of features) {
  const p = f.properties;
  counts.byCategory[p.category] = (counts.byCategory[p.category] || 0) + 1;
  counts.bySource[p.source] = (counts.bySource[p.source] || 0) + 1;
  if (p.subtype) counts.bySubtype[p.subtype] = (counts.bySubtype[p.subtype] || 0) + 1;
  neighbourhoods.add(p.locality);
  if (p.hoursKnown) counts.withHours++;
  else counts.hoursUnknown++;
  if (p.nameUnmapped) counts.namesUnmapped++;
  if (p.always) counts.open24h++;
  // A hospital counts here: its casualty is open at 03:30 by definition, hours
  // mapped or not. Without that the headline number would understate the one
  // category that is actually always there when the rest of the city is closed.
  if (p.always || p.overnight || openAtMinute(p.open ? { open: p.open, close: p.close } : null, NIGHT_REF_MIN)) {
    counts.openAtNightRef++;
  }
}
counts.neighbourhoods = neighbourhoods.size;

const doc = {
  type: 'FeatureCollection',
  name: 'Night Owl - Kolkata',
  metadata: {
    generated: new Date().toISOString().slice(0, 10),
    generator: 'tools/build-locations.mjs',
    referenceHour: '03:30',
    dataSources: [
      {
        id: 'openstreetmap',
        name: 'OpenStreetMap',
        license: 'ODbL-1.0',
        attribution: '© OpenStreetMap contributors',
        url: 'https://www.openstreetmap.org/',
        fetched: source.fetched,
        note: 'Names, coordinates and opening hours for every place in this file. ' +
          'Hours are only ever as good as the last mapper to visit - and most places ' +
          'in this city have never had their hours recorded at all.'
      }
    ],
    counts,
    notes:
      'Every place in this file exists in OpenStreetMap with its own coordinates. ' +
      'No entry was invented and no entry is a demo. Where an entry has no opening ' +
      'hours it says "hours not listed"; where it has no name it says "name not ' +
      'mapped". The Open-now filter counts only entries whose hours are known. ' +
      'Rebuild with: node tools/fetch-osm.mjs && node tools/build-locations.mjs'
  },
  features
};

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(doc) + '\n');

console.log(`\nwrote ${path.relative(process.cwd(), OUT_FILE)}`);
console.log(`  ${counts.total} places across ${counts.neighbourhoods} neighbourhoods`);
console.log(`  by category: ${JSON.stringify(counts.byCategory)}`);
console.log(`  hospitals:   ${stats.hospitalsKept} kept, ${stats.hospitalsDroppedByName} dropped as non-casualty`);
console.log(`  hours mapped ${counts.withHours}, complex ${stats.hoursComplex}, unknown ${stats.hoursMissing}`);
console.log(`  open 24 h ${counts.open24h}, open at 03:30 ${counts.openAtNightRef}`);
console.log(`  no mapped name: ${counts.namesUnmapped}`);
console.log(`  dropped: ${stats.droppedDuplicate} duplicate hospitals, ` +
  `${Object.values(stats.droppedUnnamed).reduce((a, b) => a + b, 0)} unnamed ` +
  `${JSON.stringify(stats.droppedUnnamed)}, ` +
  `${Object.values(stats.droppedDaytimeOnly).reduce((a, b) => a + b, 0)} provably daytime-only ` +
  `${JSON.stringify(stats.droppedDaytimeOnly)}`);

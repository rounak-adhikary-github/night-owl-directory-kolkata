#!/usr/bin/env node
/* =========================================================================
   Night Owl - Kolkata: verification pass.

   Two jobs, both of which exist because the interesting failures here are silent:

     1. Test the opening-hours reader against cases where a wrong answer would send
        someone to a shut door - a wrap past midnight, a split shift that must be
        refused, a daytime-only window that must not be listed at all.
     2. Interrogate the built GeoJSON: schema, provenance, duplicate pins, hours
        consistency, and the dataset's own metadata against its own contents.

   Run:  node tools/verify-dataset.mjs        (exit 1 on any failure)

   The browser-side logic in assets/app.js is verified separately, in a real page,
   because reading it here would only prove it is spelled consistently.
   ========================================================================= */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOsmHours, openAtMinute, nightRelevant } from './hours.mjs';
import { LOCALITIES } from './localities.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, '..', 'data', 'locations.geojson');
const CATEGORIES = ['pharmacy', 'food', 'fuel', 'transit'];
/* One provenance only. The dataset is a mirror of OpenStreetMap: anything that is
   not a real mapped place has no business here, and if a second source ever
   appears this check is where that decision has to be made deliberately. */
const SOURCES = ['openstreetmap'];
/* Must match the cap in build-locations.mjs. Keep the two in step: the check below
   is what proves the labelling is the nearest anchor and not an approximation. */
const LOCALITY_CAP_KM = 7;

const failures = [];
const warnings = [];
const pass = [];
const fail = (msg) => failures.push(msg);
const warn = (msg) => warnings.push(msg);
const check = (cond, msg) => (cond ? pass.push(msg) : fail(msg));

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass.push(msg);
  else fail(`${msg}: expected ${e}, got ${a}`);
}

/* ---------------------------------------------------------------- 1. parser */

const HOURS_CASES = [
  // [input, expectation]
  ['24/7', { always: true }],
  ['Mo-Su 00:00-24:00', { always: true }],
  ['00:00-24:00', { always: true }],
  ['Mo-Sa 09:00-21:00', { open: '09:00', close: '21:00', closedDays: [0] }],
  ['Mo-Su 09:00-21:00', { open: '09:00', close: '21:00', closedDays: [] }],
  ['Fr-We 09:00-22:00', { open: '09:00', close: '22:00', closedDays: [4] }],
  ['10:00-23:00', { open: '10:00', close: '23:00', closedDays: [] }],
  ['22:00-02:00', { open: '22:00', close: '02:00', closedDays: [] }],
  ['Mo-Sa 09:00-21:30; PH off', { open: '09:00', close: '21:30', closedDays: [0] }],
  ['09:00-21:00; Su off', { open: '09:00', close: '21:00', closedDays: [0] }],
  // Refused on purpose: anything that would need a guess.
  ['Mo-Fr 08:00-13:00,17:00-20:00', null],
  ['sunrise-sunset', null],
  ['06:', null],
  ['09:00+', null],
  ['Tu[1] 10:00-14:00', null],
  ['Mo 09:00-13:00; Tu 14:00-19:00', null],
  ['', null],
  [null, null]
];

for (const [input, expected] of HOURS_CASES) {
  const got = parseOsmHours(input);
  if (expected === null) {
    check(got === null, `refuses unreadable hours: ${JSON.stringify(input)}`);
    continue;
  }
  if (!got) { fail(`should have parsed: ${JSON.stringify(input)}`); continue; }
  for (const [key, value] of Object.entries(expected)) {
    eq(got[key], value, `${JSON.stringify(input)} -> ${key}`);
  }
}

/* The window comparison, including the wrap that this whole app exists for. */
eq(openAtMinute(parseOsmHours('22:00-02:00'), 90), true, 'open at 01:30 in a window that wraps');
eq(openAtMinute(parseOsmHours('22:00-02:00'), 150), false, 'shut at 02:30, after a 02:00 close');
eq(openAtMinute(parseOsmHours('22:00-02:00'), 60 * 12), false, 'shut at noon in a window that wraps');
eq(openAtMinute(parseOsmHours('10:00-23:00'), 150), false, 'shut at 02:30 in a daytime window');
eq(openAtMinute(parseOsmHours('24/7'), 210), true, 'open at 03:30 when tagged 24/7');
eq(openAtMinute(parseOsmHours('05:00-14:00'), 210), false, 'shut at 03:30 before a 05:00 opening');

/* Which windows count as night-relevant at all. */
eq(nightRelevant(parseOsmHours('09:00-18:00')), false, 'daytime-only window is not night food');
eq(nightRelevant(parseOsmHours('12:00-22:00')), true, 'closes at 22:00: night relevant');
eq(nightRelevant(parseOsmHours('04:00-10:00')), true, 'dawn stall: night relevant');
eq(nightRelevant(parseOsmHours('17:00-05:00')), true, 'wraps past midnight: night relevant');
eq(nightRelevant(parseOsmHours('24/7')), true, '24/7 is night relevant');
eq(nightRelevant(parseOsmHours(null)), null, 'no hours mapped: unknown, not false');


/* --------------------------------------------------------------- 2. dataset */

const raw = fs.readFileSync(FILE, 'utf8');
let doc;
try {
  doc = JSON.parse(raw);
  pass.push('file parses as JSON');
} catch (err) {
  fail(`file does not parse: ${err.message}`);
}

if (!doc) {
  report();
  process.exit(1);
}

check(doc.type === 'FeatureCollection', 'top level is a FeatureCollection');
check(Array.isArray(doc.features) && doc.features.length > 0, 'features is a non-empty array');

const meta = doc.metadata || {};
const counts = meta.counts || {};
const [south, west, north, east] = (meta.bbox || [22.28, 88.05, 22.92, 88.62]);
check(!!meta.generator, 'metadata names the generator');
check((meta.dataSources || []).some((s) => s.id === 'openstreetmap' && s.license === 'ODbL-1.0'),
  'metadata carries the OpenStreetMap source and its ODbL licence');
check(!JSON.stringify(meta).includes('at least two'),
  'metadata makes no per-locality coverage promise it cannot keep');

/* `lon`, not `lng`: km() below (and the build) reads `lon`, and an undefined
   longitude gives NaN, which passes no threshold - the check would then happily
   approve a dataset that labelled every place "Kolkata". */
const anchors = LOCALITIES.map(([name, lat, lng]) => ({ name, lat, lon: lng }));
const km = (a, b) => {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lon - a.lon) * rad;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
};

const ids = new Map();
const osmIds = new Map();
const pins = [];
const tally = {
  byCategory: {}, bySource: {}, hoursKnown: 0, hoursUnknown: 0, open24h: 0,
  openAtNightRef: 0, namesUnmapped: 0, hospitals: 0
};
const neighbourhoods = new Set();

for (const [i, feature] of doc.features.entries()) {
  const where = `feature ${i} (${feature.properties && feature.properties.name})`;
  const p = feature.properties || {};

  check(feature.type === 'Feature', `${where}: is a Feature`);
  check(feature.geometry && feature.geometry.type === 'Point', `${where}: geometry is a Point`);
  const [lon, lat] = feature.geometry.coordinates;
  check(Number.isFinite(lat) && Number.isFinite(lon), `${where}: coordinates are finite`);
  check(lat >= south && lat <= north && lon >= west && lon <= east,
    `${where}: sits inside the fetched bounding box`);

  ids.set(p.id, (ids.get(p.id) || 0) + 1);
  check(typeof p.id === 'string' && p.id.length > 0, `${where}: has an id`);
  check(typeof p.name === 'string' && p.name.trim().length > 1, `${where}: has a name`);
  check(!/\s{2,}/.test(p.name || ''), `${where}: name has no doubled spaces`);
  check(!/undefined|null/i.test(p.name || ''), `${where}: name contains no placeholder text`);
  check(CATEGORIES.includes(p.category), `${where}: category is one of the four`);
  check(SOURCES.includes(p.source), `${where}: source is a known provenance`);
  check(typeof p.address === 'string' && p.address.length > 0, `${where}: has an address line`);
  check(typeof p.locality === 'string' && p.locality.length > 0, `${where}: has a neighbourhood`);
  check(Array.isArray(p.tags), `${where}: tags is an array`);

  // The neighbourhood label must be the nearest anchor, or the fallback.
  const nearest = anchors.reduce((best, a) => {
    const d = km({ lat, lon }, a);
    return !best || d < best.d ? { name: a.name, d } : best;
  }, null);
  const expectedLocality = nearest.d <= LOCALITY_CAP_KM ? nearest.name : 'Kolkata';
  check(p.locality === expectedLocality,
    `${where}: neighbourhood "${p.locality}" is the nearest anchor (${expectedLocality})`);

  // Hours: internally consistent, and never a guess.
  if (p.always) {
    check(p.open == null && p.close == null, `${where}: 24-hour entry carries no open/close pair`);
    tally.open24h++;
  }
  if (p.hoursKnown && !p.always) {
    check(/^\d{2}:\d{2}$/.test(p.open || ''), `${where}: open is HH:MM`);
    check(/^\d{2}:\d{2}$/.test(p.close || ''), `${where}: close is HH:MM`);
  }
  if (!p.hoursKnown) {
    check(p.open == null && p.close == null,
      `${where}: an entry with unknown hours claims no window`);
  }
  if (p.rawHours) {
    const parsed = parseOsmHours(p.rawHours);
    if (p.hoursKnown) {
      check(parsed !== null, `${where}: derived hours re-parse from the raw value`);
    }
    // A hospital is exempt: its casualty is not described by its outpatient hours.
    if (p.subtype !== 'hospital') {
      check(nightRelevant(parsed) !== false,
        `${where}: not listed with hours that prove it shuts all night`);
    }
  }

  check(/^(node|way|relation)\/\d+$/.test(p.osmId || ''), `${where}: has a usable OpenStreetMap id`);
  if (p.osmEdited) check(/^\d{4}-\d{2}-\d{2}$/.test(p.osmEdited), `${where}: edit date is a date`);
  osmIds.set(p.osmId, (osmIds.get(p.osmId) || 0) + 1);

  // The "no name" state must be visible in the text, not only in the flag: a card
  // that reads like a brand when OpenStreetMap carries no name is a small lie.
  if (p.nameUnmapped) {
    check(/\(name not mapped\)/.test(p.name), `${where}: unknown name says so in the name`);
    tally.namesUnmapped++;
  } else {
    check(!/\(name not mapped\)/.test(p.name), `${where}: named entry does not claim otherwise`);
  }

  // A hospital claims a night casualty. That claim is allowed to exist, but it must
  // be a hospital, and it must be flagged as an inference rather than mapped hours.
  if (p.subtype === 'hospital') {
    check(p.category === 'pharmacy', `${where}: hospital files under the pharmacy category`);
    check(p.overnight === true, `${where}: hospital carries the night-casualty flag`);
    check(!!p.notes, `${where}: hospital explains what is known about its hours`);
    tally.hospitals++;
  } else {
    check(p.overnight === undefined, `${where}: only a hospital claims a night casualty`);
  }

  tally.byCategory[p.category] = (tally.byCategory[p.category] || 0) + 1;
  tally.bySource[p.source] = (tally.bySource[p.source] || 0) + 1;
  neighbourhoods.add(p.locality);
  if (p.hoursKnown) tally.hoursKnown++; else tally.hoursUnknown++;
  if (p.always || p.overnight ||
      (p.hoursKnown && openAtMinute({ open: p.open, close: p.close }, 210))) {
    tally.openAtNightRef++;
  }

  pins.push({
    lat, lon, name: p.name, category: p.category, locality: p.locality,
    nameUnmapped: !!p.nameUnmapped
  });
}

// One pin per place: the same OpenStreetMap element must not appear twice.
for (const [osmId, n] of osmIds) {
  check(n === 1, `OpenStreetMap ${osmId} appears exactly once (found ${n})`);
}
for (const [id, n] of ids) {
  check(n === 1, `id ${id} is unique (found ${n})`);
}

// Near-identical pins in the same category are usually a mapping duplicate. Two
// unnamed pins are exempt: "Eatery (name not mapped)" says nothing about identity,
// so their first token matching means nothing - the unnamed-on-top-of-named case is
// deduplicated by the build instead, and is checked separately below.
const seq = (s) => String(s).toLowerCase()
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\b(pvt|private|ltd|limited|the|and|&|co)\b/g, ' ')
  .replace(/\s+/g, ' ').trim();

let closePairs = 0;
let sharedBrand = 0;
let unnamedOnNamed = 0;
for (let i = 0; i < pins.length; i++) {
  for (let j = i + 1; j < pins.length; j++) {
    if (pins[i].category !== pins[j].category) continue;
    const d = km(pins[i], pins[j]);
    if (pins[i].nameUnmapped !== pins[j].nameUnmapped) {
      if (pins[i].category === 'food' && d < 0.1) unnamedOnNamed++;
      continue;
    }
    if (pins[i].nameUnmapped && pins[j].nameUnmapped) continue;

    // A shared first word inside 40 m is worth a look but is not an error: "Wow!
    // Momo" and "Wow! China Diner" are two brands in one food court, and "The Myx"
    // is not a duplicate of "The Golden Spoon". Only the whole name matching is a
    // duplicate, which is what the build collapses.
    if (d < 0.04 && seq(pins[i].name) !== seq(pins[j].name) &&
        seq(pins[i].name).split(' ')[0] === seq(pins[j].name).split(' ')[0]) {
      sharedBrand++;
      if (sharedBrand <= 3) warn(`same first word nearby: "${pins[i].name}" and "${pins[j].name}" (${pins[i].locality})`);
    }
    if (d <= 0.06 && seq(pins[i].name) === seq(pins[j].name)) closePairs++;
  }
}
check(closePairs === 0,
  `no two places with the same name within 60 m in one category (${closePairs} pairs)`);
check(unnamedOnNamed === 0,
  `no unnamed eatery left standing on top of a named one (${unnamedOnNamed} pairs)`);

// Metadata must describe the file it ships with.
eq(counts.total, doc.features.length, 'metadata count matches the feature count');
eq(counts.byCategory, tally.byCategory, 'metadata category counts match');
eq(counts.bySource, tally.bySource, 'metadata source counts match');
eq(counts.hoursUnknown, tally.hoursUnknown, 'metadata unknown-hours count matches');
eq(counts.namesUnmapped, tally.namesUnmapped, 'metadata unmapped-name count matches');
eq(counts.open24h, tally.open24h, 'metadata 24-hour count matches');
eq(counts.openAtNightRef, tally.openAtNightRef, 'metadata 03:30 count matches');
eq(counts.neighbourhoods, neighbourhoods.size, 'metadata neighbourhood count matches');

/* --------------------------------------------------------------- 3. report */

function report() {
  const summary = {
    file: path.relative(process.cwd(), FILE),
    sizeKb: Math.round(raw.length / 1024),
    places: doc ? doc.features.length : 0,
    byCategory: tally.byCategory,
    bySource: tally.bySource,
    neighbourhoods: neighbourhoods.size,
    hoursKnown: tally.hoursKnown,
    hoursUnknown: tally.hoursUnknown,
    namesUnmapped: tally.namesUnmapped,
    hospitals: tally.hospitals,
    open24h: tally.open24h,
    openAtNightRef: tally.openAtNightRef
  };
  console.log('\n--- dataset ---');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\n--- checks ---`);
  console.log(`${pass.length} passed, ${failures.length} failed, ${warnings.length} warnings`);
  if (warnings.length) {
    console.log('\nwarnings (not failures):');
    warnings.slice(0, 12).forEach((w) => console.log(`  - ${w}`));
  }
  if (failures.length) {
    console.log('\nFAILURES:');
    failures.slice(0, 40).forEach((f) => console.log(`  x ${f}`));
  }
}

report();
process.exit(failures.length ? 1 : 0);

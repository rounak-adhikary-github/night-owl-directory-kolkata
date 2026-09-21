# Night Owl · Kolkata

A dark-mode-first, filterable map of the places that are still open when the rest of
Kolkata has shut: chemist counters, late-night food, petrol pumps, and the transit
points where you can wait for a ride home. Static files, no server, no API key —
built to be hosted on GitHub Pages exactly as it sits in this folder.

**Every place in it is a real place, taken from OpenStreetMap.** There is no demo
data, no generated filler and no hand-written seed list in this repository any more:
1,611 entries, each one an actual mapped business, station or hospital with its own
coordinates, its own OpenStreetMap id, and its own last-edit date so you can judge how
stale it is.

```
index.html                 the whole app: shell, filters, map, bottom sheet
assets/style.css           dark-first design system (tokens at the top)
assets/app.js              Leaflet setup, filters, geolocation sort, sheet gestures
data/locations.geojson     the dataset the app loads (1,611 places, ~980 KB)
tools/fetch-osm.mjs        download real places from OpenStreetMap (the only networked step)
tools/build-locations.mjs  OpenStreetMap extract -> data/locations.geojson
tools/hours.mjs            opening_hours reader, with its test corpus
tools/localities.mjs       117 neighbourhood anchors, used for labels and search
tools/verify-dataset.mjs   parser tests + dataset audit (34,991 checks)
tools/osm-source.json      the committed extract the build reads (offline rebuild)
```

Everything is referenced with relative paths, so it works at
`https://<user>.github.io/<repo>/` unchanged.

## Hosting it

Push this folder's contents, then **Settings → Pages → Deploy from a branch →
`main` / root**. `.nojekyll` is already present so Pages serves the `assets/` and
`data/` directories without Jekyll processing them. To preview locally, any static
server will do:

```bash
cd testCode && python -m http.server 8231
```

## Where the data comes from

Two commands, and only the first one touches the network:

```bash
node tools/fetch-osm.mjs      # Overpass API -> tools/osm-source.json (cached per category)
node tools/build-locations.mjs # -> data/locations.geojson
```

`fetch-osm.mjs` queries the [Overpass API](https://overpass-api.de/) for the Greater
Kolkata box (`22.28,88.05,22.92,88.62` — Budge Budge to Barrackpore, Domjur to
Rajarhat) and keeps only the tags the directory uses. It rotates between four public
mirrors, backs off on HTTP 429/504, caches each category separately so an interrupted
run resumes, and refuses to cache an empty result that is really a mirror giving up
(there is a count query to tell the difference).

`build-locations.mjs` runs offline from that extract. It never invents a place, a
coordinate or an hour.

Data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright),
available under the ODbL. Attribution is in the app footer and on every popup.
Fetched **2026-09-21**.

### Why not Google

Google Places would be the other obvious source, and it is not usable here: it needs
an API key, a billing account and a server-side proxy to keep the key out of a public
page — none of which a static GitHub Pages directory has. OpenStreetMap is the only
source that is real, keyless, redistributable under a licence that permits this, and
queryable in bulk. It also happens to be the one that improves when you fix it.

## What is actually in it

| Category | Places | Provably open at 03:30 | Median distance from a neighbourhood centre |
| --- | ---: | ---: | ---: |
| 24/7 pharmacy *(incl. 340 hospitals)* | 474 | 344 | 0.56 km |
| Late-night food | 727 | 10 | 0.56 km |
| Petrol pump & mechanic | 77 | 2 | 1.35 km |
| Transit pickup | 333 | 0 | 0.57 km |
| **Total** | **1,611** | **356** | **0.59 km** |

Coverage, measured against all **117** neighbourhood anchors rather than asserted:

- Something open at 03:30 is within **0.59 km** of the median anchor, **1.6 km** for
  the 90th percentile, **2.33 km** at the very worst.
- Every one of the 117 anchors has a pharmacy **and** a food place within 2 km, except
  three rural-ish corners for food (worst case 8 km, at the edge of the box).
- Fuel is deliberately sparser: 77 pumps on arterials, not one per lane.

## The honest part: hours

OpenStreetMap in Kolkata has excellent geometry and almost no opening hours.
**152 of 1,611 entries carry hours this app can read**, 27 are tagged `24/7`, and
**1,459 say "hours not listed"**. So:

- The **Open-now** filter matches 356 entries — 340 of them hospitals, where a night
  casualty is a property of the hospital rather than of the mapped hours.
- Food and transit are hit hardest: a roll counter's hours are essentially never
  recorded, so at 03:30 the app can *show* you the food but cannot *promise* it.
- Nothing is guessed to fill the gap. An entry with unreadable hours keeps the raw
  string (`"Mo-Fr 13:00-15:30,18:00-23:00"`) and is shown as *"See hours"*; an entry
  with no hours at all is shown as *"Hours not listed"* and is excluded from the
  open-now count. The status line reports it separately: *"431 of 1611 open right
  now, 1139 with hours unlisted."*

This is the dataset's main weakness and it is OpenStreetMap's, not the app's. The fix
is a five-minute edit: open any place's popup, follow **OSM entry**, sign in and add
`opening_hours`. Re-run the two commands above and it is in everyone's map.

## What was removed, and what is inferred

The previous version of this folder held 37 hand-written entries and 363 generated
ones. Both are gone, along with the seed file, the generator and every code path that
read them — `git status` shows the deletion. Nothing in `data/locations.geojson` now
comes from anywhere but OpenStreetMap.

Three judgement calls survive in the build, and each one is labelled in the data:

1. **Hospitals are listed as pharmacies, and flagged `overnight`.** The query returns
   443 elements, of which 78 are dropped by name as things that are never a 3 AM
   resource (eye, dental, IVF, diagnostic, veterinary…). The remaining 358 are
   collapsed to **340 pins** after de-duplicating campuses that are mapped as several
   buildings. A hospital keeps a night casualty whether or not the mapper typed its
   hours in, so `overnight: true` puts it in the open-now count — and the popup says
   *"casualty hours not mapped"* rather than pretending the hours are known.
2. **Unnamed places.** 35 entries have a position and no name; they are kept, shown in
   italic as *"Eatery (name not mapped) - Behala"*, and flagged `nameUnmapped`. An
   unnamed **hospital, pump or station** is dropped instead — at 3 AM "there is a
   building here" is useless to give a driver.
3. **Counts.** 29 unnamed eateries that sit within 100 m of a named one are dropped as
   the same shop mapped twice, as are same-named entries within 60 m in one category.
   23 entries whose mapped hours prove they shut for the whole night are dropped.

Places further than 7 km from any of the 117 anchors are labelled `"Kolkata"` (203 of
them, mostly the outer suburbs); everything else carries its nearest real
neighbourhood, which is what makes `behala` or `new town` searchable.

## Verification

```bash
node tools/verify-dataset.mjs
```

Runs the opening-hours reader against 18 hand-picked cases (a window that wraps past
midnight must be open at 02:30 and shut at noon; a split shift must be refused rather
than approximated) and then audits the built file: schema, bounding box, one pin per
OpenStreetMap element, hours consistency, no unmapped-name entry that reads like a
brand, no hospital claiming anything it is not, and the metadata counts against the
file's own contents. Currently **34,991 checks pass, 0 fail, 3 warnings** — the
warnings are "same first word nearby" cases like *"Wow! Momo"* and *"Wow! China
Diner"*, which are two real brands in one food court.

The browser side was checked in a real page, not by reading the code: 1,611 features
load and cluster, a full filter rebuild takes ~108 ms, nearest-first from a simulated
fix at Park Circus returns Quest Mall's food within 230 m with correct distance bands,
`behala` returns 14 places, and there are no console errors and no failed tile
requests.

## The interface

Dark-first, because the user is standing on a street at 3:30 AM:

- `#121212` app background, `#1E1E1E` surfaces, text at 87% / 60% opacity. No pure
  black (OLED smear) and no pure white (halation).
- Desaturated accents so nothing vibrates against the dark: mint `#81C784` pharmacy,
  amber `#FFB74D` food, cyan `#4DD0E1` fuel, lavender `#B39DDB` transit.
- Glassmorphism on the panel, popups, chips and popovers (`backdrop-filter` plus a
  1px `rgba(255,255,255,.12)` hairline) — in dark mode a border reads as elevation
  where a drop shadow would vanish.
- 48px minimum touch targets, a draggable bottom sheet on phones that becomes a
  sidebar at ≥1000px, and keyboard access (`/` to search, `Esc` to clear).

**Basemap note.** The brief said CARTO Dark Matter. Built as specified, the screenshot
came back with `API KEY REQUIRED` stamped across every tile: CARTO now gates the
basemap CDN. A watermarked map is worse than no map, so the default is Esri's *World
Dark Gray Canvas* (base + label overlay as two stacked layers) — keyless, unwatermarked,
with roads, the river and place labels legible. Basemap switcher also offers full-colour
streets and satellite.

## Contributing

Add real places to **OpenStreetMap**, not to this repository:

```bash
node tools/fetch-osm.mjs && node tools/build-locations.mjs && node tools/verify-dataset.mjs
```

The most valuable contribution by far is `opening_hours` on the 1,459 entries that
have none.

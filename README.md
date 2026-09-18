# Night Owl - Kolkata

A single-page, map-based directory of the things that stay open after midnight in Kolkata:
24/7 pharmacies, late-night food, petrol pumps and mechanics, and safe transit pickup
points. Built for the 3:30 AM shift-end moment, on a phone, on a dark street.

No build step, no framework, no API keys, no backend. Static files and one GeoJSON
document. If you can host a file, you can host this.

```
testCode/
├── index.html                      # the app shell
├── assets/
│   ├── style.css                   # dark-mode-first design system
│   └── app.js                      # Leaflet setup, filters, geolocation, sheet gestures
├── data/
│   └── locations.geojson           # 400 places, 117 localities (the runtime dataset)
├── tools/
│   ├── seed-locations.geojson      # 37 hand-written entries (the curated seeds)
│   └── generate-locations.mjs      # rebuilt the dataset: seeds + generated coverage
├── .nojekyll                       # serve files as-is on GitHub Pages
└── README.md
```

## Hosting it on GitHub Pages

1. Commit this folder to a repository.
2. **Settings → Pages → Source: Deploy from a branch**, pick your branch and the folder
   (`/ (root)` if `testCode` is the repo root, or the matching path if it is nested).
3. Open `https://<user>.github.io/<repo>/testCode/`.

Every path in the project is **relative** (`assets/…`, `data/…`), so it works unchanged at
a repo subpath, at a user page root, or on any other static host. `tools/` is never
requested by the page - it is there for whoever maintains the data.

> **Opening it from disk will not work.** Double-clicking `index.html` sends a `file://`
> request, and browsers block `fetch()` for local files. The page detects this and says so
> instead of failing silently. To preview locally, serve the folder:
> `python3 -m http.server 8000` then visit `http://localhost:8000/`.

Geolocation is a secure-context API: it works on GitHub Pages (https) and on
`http://localhost`, but not on a plain `http://` LAN address. Over plain http the page
still works; only the "nearest to me" sort is unavailable.

## Read this before you trust the data

The dataset has **mixed provenance**, and it is labelled as such:

| | Count | What it is |
| --- | --- | --- |
| `"source": "curated-seed"` | 37 | Hand-written against real Kolkata places (Dacres Lane, Kusum Rolls, Arsalan, Howrah Station, the Howrah bridge approach pumps...) |
| `"source": "synthetic-fill"` | 363 | Generated from **real localities and real road names**, but the businesses are invented |

- **Coordinates are locality-accurate to a few hundred metres, not to a doorstep.** Every
  entry is jittered inside its own locality, so a pin tells you the right neighbourhood and
  the right road at best.
- **No entry is ground-verified.** `verified` is `null` throughout. Some timings are
  realistic but none of them have been checked by a person standing there.
- **Phone numbers are deliberately absent.** These entries originally carried placeholder
  numbers like `+91 33 4000 0001`. Even as obvious fakes that is a bad idea: someone
  finishing at 3:30 AM taps "Call" and dials a stranger. The `phone` field is fully
  supported by the schema and the popup will show a **Call** button the moment a real,
  verified number is added - so add one only when you have actually seen it printed on the
  shop.
- `nightGuaranteed: true` marks the 32 entries whose hours were nudged by the coverage pass
  (below) so their locality would not be empty at 03:30.

Treat this as a working demonstration of the product, with a data pipeline you can point
at real data - not as a directory anyone should navigate by.

## Coverage

400 places across 117 Kolkata localities, from Barrackpore and Barasat in the north, through
Behala and Thakurpukur in the south-west, out to Rajarhat, New Town and the Airport in the
east, across to Howrah, Bally and Domjur on the other bank.

| Category | Places | Open at 03:30 | Open at 22:00 |
| --- | --- | --- | --- |
| 24/7 pharmacy | 126 | 103 | 124 |
| Late-night food | 128 | 88 | 119 |
| Petrol pump / mechanic | 75 | 58 | 73 |
| Safe transit pickup | 71 | 56 | 71 |
| **Total** | **400** | **305 (76%)** | **387 (97%)** |

Three guarantees hold across the whole dataset, and each one exists because the first
version of this file broke it:

> **1. Every locality has a chemist.** Someone who needs medicine at 3 AM should not be
> told the nearest one is four kilometres away.

> **2. Every locality has something hot to eat.**

> **3. At least two places are open at 03:30 in every one of the 117 localities.**

The first version failed all three. Purely global balancing fed slots to whichever category
was furthest behind nationally, so **49 localities ended up with no food at all** and five
(Bowbazar, Jadavpur, Panchasayar, Baranagar, Shibpur) had *nothing* open at 3:30 - someone
standing there would open the app and see an empty list. So the generator allocates in three
phases: essentials first (one chemist and one food place per locality, always), then arterial
coverage (fuel and transit for the core / market / transit / tech / highway profiles), then
the rest by profile-weighted global deficit. A final pass walks every locality, counts what
is open at 03:30, and converts its own synthetic entries until two are - it never touches a
curated seed. That pass adjusted 26 entries.

Note what is *not* guaranteed: 49 localities have no fuel pump and 52 have no transit pickup.
That is deliberate. Pumps and cab ranks belong on the arterial roads, junctions and station
forecourts, not in every residential lane, and a night network that claims a 24-hour petrol
pump on every other street would be lying. Coverage is dense where density is real.

## The data pipeline

`data/locations.geojson` is a generated artefact. To change it, edit the inputs and rebuild:

```bash
node tools/generate-locations.mjs      # writes data/locations.geojson
```

The build is **deterministic** (fixed PRNG seed, `seed: 20260918`), so re-running it
produces a byte-identical file and clean diffs. Three things go into it:

1. **`tools/seed-locations.geojson`** - the hand-written entries, passed through untouched
   except that ids are reissued (`ph-001`, `fd-014`, …) with the seeds first in each
   category. `#ph-001` is always Apollo Pharmacy on Park Street.
2. **`LOCALITIES`** in the generator - 117 locality anchors with real coordinates, a density
   weight, a profile (core / market / transit / tech / highway / residential) and two or
   three real street names each. The profile drives the category mix, so a market street
   gets food stalls while B. T. Road and the Kona Expressway get pumps.
3. **Hours buckets** per category - weighted, skewed hard to the night. Windows that cross
   midnight are written honestly (`"open": "17:00", "close": "05:00"`), which is what the
   app's "open now" logic reads.

Category allocation runs in three phases (essentials, arterial coverage, then global
debt), and a final pass enforces night coverage per locality - see [Coverage](#coverage).
If you add a locality to `LOCALITIES`, all of that applies to it automatically; you get two
guaranteed entries plus its share of the rest.

### Schema

```json
{
  "type": "Feature",
  "geometry": { "type": "Point", "coordinates": [88.3520, 22.5535] },
  "properties": {
    "id": "ph-001",
    "name": "Apollo Pharmacy - Park Street",
    "category": "pharmacy",
    "locality": "Park Street",
    "address": "18B Park Street, beside Park Street Metro Gate 2",
    "source": "curated-seed",
    "always": true,
    "hours": "Open 24 hours",
    "tags": ["park street", "chemist", "medicine"],
    "verified": null
  }
}
```

- `coordinates` is `[longitude, latitude]` - GeoJSON order, not the order you say it in.
- `category` must be one of `pharmacy`, `food`, `fuel`, `transit`.
- A `close` earlier than `open` means the window **wraps past midnight**; the app reads it
  that way rather than treating it as an error.
- `"always": true` means 24x7 and replaces `open`/`close`.
- `closedDays` is optional, JS day numbers (`[0]` = closed Sundays).
- `phone` is optional and unused in the shipped sample - see the warning above.

### Pointing it at real data

The whole runtime contract is "a GeoJSON FeatureCollection of Points with those properties",
so swapping in reality is a data problem, not a code problem:

```bash
# rough starting point: OpenStreetMap has pharmacies, fuel stations and many late-night
# eateries across Kolkata. Export from Overpass as GeoJSON, then map the tags onto the
# schema above. Example query for 24/7 pharmacies inside the city:
cat > /tmp/q.overpass <<'EOF'
[out:json][timeout:180];
area["name"="Kolkata"]->.k;
node(area.k)["amenity"="pharmacy"]["opening_hours"];
out body;
EOF
curl -s https://overpass-api.de/api/interpreter --data-urlencode "data@/tmp/q.overpass"
```

OSM `opening_hours` values like `24/7` or `Mo-Su 08:00-02:00` map cleanly onto
`always` / `open` / `close`. Expect far fewer than 400 real entries, thinner timings, and a
lot of `opening_hours` that is simply wrong - field verification is the only thing that
makes a night directory trustworthy, which is exactly why every entry here says so.

## The design system

Dark-mode-first, because this is an outdoor, low-light utility. Tokens live at the top of
`assets/style.css`; the values below are the whole palette.

| Role | Value | Why |
| --- | --- | --- |
| App background | `#121212` | Never `#000` - pure black smears on OLED while scrolling |
| Card / floating surface | `#1E1E1E`, `#262626` | Elevation by lightness; shadows vanish on dark |
| Primary text | `rgba(255,255,255,.87)` | Softens to ~`#E0E0E0`; pure white halates |
| Secondary text | `rgba(255,255,255,.60)` | Hierarchy from opacity, not from font size |
| Hairline | `rgba(255,255,255,.12)` | Borders separate, shadows do not |
| 24/7 pharmacy | `#81C784` | Soft mint |
| Late-night food | `#FFB74D` | Pastel amber |
| Pump / mechanic | `#4DD0E1` | Muted cyan |
| Safe pickup | `#B39DDB` | Dusty lavender (5th category) |
| Closed / caution | `#E57373` | Light coral - a status, never a category |

Accents are desaturated 20-30% from their Material 300 sources so they do not vibrate
against the dark background. Active filter chips use tinted glass plus the accent as text
(~6:1 contrast) rather than a solid bright fill, which keeps glare down while still reading
instantly. Every interactive target is at least 48px - including the cluster bubbles and
the small secondary controls, which use a transparent `::after` overlay to widen their hit
area without growing visually.

Glassmorphism is the layering language: panels, the sheet, map controls and the info popup
all use `backdrop-filter: blur(18px) saturate(140%)` over `rgba(24,24,24,.66)`, with a 1px
hairline border. There is a `@supports not (backdrop-filter)` fallback to a near-opaque
surface, plus `prefers-reduced-motion` and `prefers-contrast: more` handling.

## The map

The default basemap is **Esri's World Dark Gray Canvas** (base + label reference). It is
dark but not black, so roads, the river, parks and place labels all stay legible and the
glass UI and markers sit on top instead of on a blank void.

**Why not CARTO Dark Matter?** Dark Matter is still the best-looking dark basemap going,
and it was the first choice here. CARTO now requires an API key for the basemap CDN, and
keyless requests come back stamped with `API KEY REQUIRED` across the tiles. A watermarked
map is worse than no map, so the default moved to a keyless, unwatermarked source. Both
CARTO layers were dropped rather than shipped broken. If you hold a CARTO key, add a
`dark_all` layer back with `?api_key=...` and its attribution string in `LAYERS` in
`assets/app.js` - the switcher takes any number of tile layers per style.

Other deliberate map choices:

- **Stacked tiles for the dark theme.** `World_Dark_Gray_Base` plus
  `World_Dark_Gray_Reference` (labels) are two tile layers in the same pane.
- **No tile inversion hack.** `filter: invert(100%) hue-rotate(180deg)` is the classic
  rescue for being stuck with bright OSM tiles. It also destroys place-label legibility and
  turns water into glow-in-the-dark orange. Choosing the right source beats filtering the
  wrong one.
- **The map is switchable.** Dark Gray Canvas, Esri World Street Map (full colour) and World
  Imagery (satellite). Night is the default; the others are for daylight, for a screenshot,
  or for orienting yourself against a building you can actually see.
- **"Dim map"** scrims the tiles *below* the UI and drops tile brightness to 78%. Text stays
  at full contrast while the largest light source on the screen gets quieter.
- **Initial framing is the city core, not the whole metro belt.** Fitting all 400 places
  frames Barrackpore to Budge Budge and parks a third of the city in one bubble at zoom 9.5.
  The opening view uses the 10th-90th percentile bounds instead; panning out still reveals
  the edge localities.
- Attribution is real and visible (bottom-left, above the sheet) and changes with the
  basemap. It is a licence requirement, not a watermark - stripping it is not an option.

## What it does

- Filter by category, search names/addresses/tags/**localities**, toggle "Open now"
  (computed from the current clock, including windows that wrap past midnight).
- **"Near me"** uses the browser Geolocation API, draws your position with an accuracy ring,
  sorts the list by haversine distance, and groups results into distance bands (under 1 km,
  1 km out, 2 km out…). With 400 entries spread citywide, "which of these is near *me*" is
  the question that matters, so this is a first-class action rather than a buried toggle.
- The list is **paged, 48 cards at a time**. Four hundred cards is a lot of DOM for a phone
  and nobody scrolls past the first few dozen; "Show more" appends so your scroll position
  survives the tap. A full filter change re-renders 400 clustered markers in ~55 ms.
- Every card and marker popup carries straight-line distance, live open/closed status,
  night-specific notes, safety notes for transit points, and a **Directions** link straight
  into Google Maps navigation.
- Markers are 48px tap targets with 34px visual discs, an "open now" halo, and a coral dot
  for closed places. **Leaflet.markercluster** groups overlapping pins into glass count
  bubbles (tinted with the category's accent when every member shares one) - at city zoom
  that is the difference between a tappable map and one grey blob. The popup path calls
  `zoomToShowLayer` for a clustered marker, with a timeout fallback, so a deep link or a
  list tap still lands on the right pin.
- Deep links: `…/index.html#ph-001` opens with that place selected and its popup up.
- Keyboard: `/` focuses search, `Esc` clears, the sheet handle responds to `Enter`/`Space`,
  markers are tabbable.
- Errors are surfaced in the page, not swallowed. A static site that fails silently is a
  static site nobody can debug.

## Dependencies

Two CDN files, both pinned with Subresource Integrity so a tampered copy cannot execute:

- [Leaflet 1.9.4](https://leafletjs.com) - mapping
- [Leaflet.markercluster 1.5.3](https://github.com/Leaflet/Leaflet.markercluster) -
  clustering. If it ever fails to load, the app falls back to a plain layer group instead of
  throwing, so the page still works.

No build step, no bundler, no package manager, and no runtime dependency on the generator.

## Licence

Code MIT. Data ODbL. Basemap tiles belong to their providers (Esri and its data suppliers)
and are subject to their terms, which is why the attribution control stays visible.

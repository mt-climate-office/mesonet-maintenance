# Mesonet Station Maintenance

A live maintenance-visit map for the [Montana Mesonet](https://climate.umt.edu/mesonet/), built and operated by the [Montana Climate Office](https://climate.umt.edu).

**Live:** [mesonet.climate.umt.edu/maintenance](https://mesonet.climate.umt.edu/maintenance/) —
the canonical URL. The same page is also served from its GitHub Pages origin at
[mt-climate-office.github.io/mesonet-maintenance](https://mt-climate-office.github.io/mesonet-maintenance/).

## About

Shows which stations have had a maintenance visit this calendar year and which are overdue, read live from the Montana Climate Office's AirTable maintenance log on every page load. Only HydroMet stations carry the once-per-year requirement (a Repair visit does not count); stations installed this year are exempt, and AgriMet stations are visited as needed and never marked overdue. The effective date of a visit is its **Visit Date**.

Three color modes:

- **Compliance** — HydroMet visited-this-year vs. overdue; new-this-year exempt; AgriMet as-needed.
- **Time since** — five bins of time since the last *Maintenance* visit, from < 1 month to > 1 year, all networks.
- **Trip type** — the type of the most recent completed visit (Maintenance, Repair, Tech Install, Structure Install, Ground Game, Other).

Other features:

- **HydroMet / AgriMet** sub-network chips with live counts.
- **Search box** with a themed dropdown, keyboard navigation (`↑` `↓` `Enter`), and a `/` global shortcut (`?kbd=off` disables it).
- **Interactive legend** — click a row to hide that category; double-click (or <kbd>Shift</kbd>+<kbd>Enter</kbd>) to isolate it.
- **Co-located sites** show a count badge and fan out on hover or tap; click a foot for that station.
- **Station popup** with the full visit history — dates, crew, trip types, tasks, sensors added/removed, and visit photos in a gallery + lightbox — plus a dashboard link.
- **Toggleable station-ID labels** with collision dodging.
- **Tribal lands** and **Montana outline** overlays; hillshade relief.
- **Light / dark / high-contrast** themes on neutral [CARTO](https://carto.com/basemaps) basemaps; honors `prefers-reduced-motion` and `prefers-color-scheme`.
- Screen-reader table twin of the map and a first-visit help dialog.

## Sharable URLs

Every piece of UI state is mirrored to the URL. Parameters appear only when they differ from the default, so the default view has a clean URL.

| Param | Values | Notes |
|---|---|---|
| `mode` | `compliance` \| `timesince` \| `triptype` | Color mode (default `compliance`) |
| `net` | space/comma list of `hydromet`, `agrimet` | Visible sub-networks; omitted when both are on |
| `cat-compliance` | list of `visited`, `overdue`, `new`, `as_needed`, `nodata` | Visible Compliance categories; omitted = all |
| `cat-timesince` | list of `0`–`4`, `null` | Visible Time-since bins (0 = `< 1 month`, 4 = `> 1 year`) |
| `cat-triptype` | list of trip-type keys (e.g. `Maintenance Repair`) | Visible Trip-type categories |
| `labels` | `on` \| `off` | Station-ID labels |
| `legend` | `open` \| `collapsed` | Legend panel state |
| `theme` | `light` \| `dark` \| `high-contrast` | Emitted only when it differs from the OS preference |
| `kbd` | `off` | Disables the `/` search shortcut |
| `lng`, `lat`, `zoom` | floats | Camera, emitted as a set when not at the Montana extent |
| `station` | station id (e.g. `aceabsar`) | Opens that station's popup on load |

Precedence per setting: URL param > `localStorage` > built-in default. Enum values are matched case-insensitively; list params accept `+`, spaces, or commas.

## Data sources

Read live on every page load from the Montana Mesonet API (`mesonet2.climate.umt.edu`), cross-origin with CORS `*`:

| Endpoint | Provides |
|---|---|
| `GET /api/v2/stations/?type=json` | Station list, names, sub-network, coordinates |
| `GET /api/v2/stations/maintenance/live?type=json` | Per-station visit timeline and calendar-year compliance, read from the AirTable maintenance table by the [mesonet-db-rds](https://github.com/mt-climate-office/mesonet-db-rds) API (300 s server-side cache) |

Visit photos are AirTable attachments on `*.airtableusercontent.com`; their URLs are signed and short-lived, and the page re-fetches within the cache window so they stay fresh.

Static overlay GeoJSON in `data/` (state outline, reservations) is checked in so the page has no runtime dependencies beyond the API.

## Development

A single static page with no build step. Serve the repo root with any static server:

```sh
python -m http.server 8000
```

Open <http://localhost:8000>. The API is called cross-origin, so no backend is needed locally.

Before pushing, run the manual verification gate (see `CLAUDE.md`): `node --check app.js`, `npx html-validate@9 index.html`, and the untracked `consumer-verify.mjs` harness, which answers the API from `fixtures/` (also untracked; the generator is in the harness header).

## Deployment

Published by GitHub Pages from the `main` branch (root), and reverse-proxied under
`mesonet.climate.umt.edu/maintenance/` by the mesonet_app Caddyfile and the
[mesonet-edge](https://github.com/mt-climate-office/mesonet-edge) CloudFront
distribution. **Pushing `main` is a production deploy.**

## History

This page was previously served by the legacy Mesonet API at `/api/v2/map/maintenance/`; its
earlier commits live in [mesonet_app](https://github.com/mt-climate-office/mesonet_app) under
`apiv2/app/app/static/maintenance/`. The old URL now redirects here.

## Tooling

- [MapLibre GL JS](https://maplibre.org) v5.18 via CDN.
- [mco-web-style](https://github.com/mt-climate-office/mco-web-style) design kit (pinned, SRI).
- [CARTO Basemaps](https://carto.com/basemaps) Positron + Dark Matter.
- Vanilla JS / HTML / CSS — no bundler, no framework.

## License

[MIT](LICENSE) — Copyright (c) 2026–present Montana Climate Office

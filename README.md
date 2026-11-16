# Mesonet Station Maintenance

A map of maintenance visits to every Montana Mesonet station, from the Montana Climate Office.

https://mesonet.climate.umt.edu/maintenance/

## Run it

```sh
python -m http.server 8000   # then open http://localhost:8000
```

There is no build step. The page calls the API cross-origin, so no backend is needed.

## Deploy

Pushing `main` deploys. GitHub Pages serves the repo root, proxied at `mesonet.climate.umt.edu/maintenance/`.
A nightly workflow commits `assets/og-card.png` to `main`, so pull before you push.
`scripts/generate_preview.py` reads `#refresh-stamp`, `#data-banner` and the `mco-maint-seen-intro` key. Keep those names.

## URL parameters

| Parameter | Values | What it does |
|---|---|---|
| `mode` | `compliance`, `timesince`, `triptype` | Color mode |
| `net` | `hydromet`, `agrimet` | Networks shown |
| `cat-compliance` | `visited`, `overdue`, `new`, `as_needed`, `nodata` | Compliance categories shown |
| `cat-timesince` | `0`–`4`, `null` | Time-since bins shown, `0` is under a month |
| `cat-triptype` | trip types, e.g. `Maintenance Repair` | Trip types shown |
| `labels` | `on`, `off` | Station ID labels |
| `legend` | `open`, `collapsed` | Legend state |
| `theme` | `light`, `dark`, `high-contrast` | Theme |
| `kbd` | `off` | Turns off the `/` shortcut |
| `lng`, `lat`, `zoom` | numbers | Camera |
| `station` | a station id, e.g. `aceabsar` | Opens that station |

Values are case-insensitive. Lists take `+`, spaces or commas.

## Data

- `https://mesonet2.climate.umt.edu/api/v2/stations/?type=json`: stations.
- `https://mesonet2.climate.umt.edu/api/v2/stations/maintenance/live?type=json`: visits, read live from the AirTable maintenance log with a 5-minute cache.
- Visit photos are AirTable attachments on `*.airtableusercontent.com`. The CSP `img-src` must allow that host.
- `data/`: the state outline and reservation overlays.
- The station panel links to `https://mesonet2.climate.umt.edu/dash/?s=<id>`.

Cutover: change `MESONET_ORIGIN` in `app.js` and the CSP `connect-src`.

## Tests

```sh
node --check app.js
npx html-validate@9 index.html
cd ../mco-web-style
node tools/verify/head.mjs       --root ../mesonet-maintenance
node tools/verify/axe-matrix.mjs --config ../mesonet-maintenance/verify.config.mjs
node tools/verify/keyboard.mjs   --config ../mesonet-maintenance/verify.config.mjs
```

## Kit

mco-web-style 1.1.0.
Design rules: mco-web-style/HOUSE-STYLE.md

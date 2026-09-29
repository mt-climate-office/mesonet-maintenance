# mesonet-maintenance

The Montana Mesonet Station Maintenance map: a static MapLibre single-page app at
the repo root (GitHub Pages root). No build step, no runtime dependencies beyond
the API and the CDN-pinned libraries in `index.html`.

## House style

This app consumes mco-web-style (pinned + SRI in `index.html`; currently
**v0.6.0** — check the tag in that file rather than trusting this line). Design
tokens, a11y mandates, and interaction conventions: see HOUSE-STYLE.md in
https://github.com/mt-climate-office/mco-web-style — tokens only (no raw hexes),
`--accent` is fill-only, `aria-pressed` drives toggle styling, canvas data needs
a live region + sr-only table twin. To change shared styling, change the kit and
bump the pinned version here; never patch a local copy.

App-local by deliberate kit decision (do NOT extract): the compliance model
(`MODES` in `app.js` — which trip types qualify, exemptions, time bins), the
colocation/spider fan-out, the visit-history popup with photo gallery + lightbox,
and the trip-type chips. Category colors in `MODES` are the one place raw hexes
are allowed: they are data-vis ramps, recorded with their measured contrast.

## Data

Two absolute API URLs, both under `API_BASE` at the top of `app.js`
(`https://mesonet2.climate.umt.edu/api/v2`): `/stations/?type=json` and
`/stations/maintenance/live?type=json`. The maintenance feed is a live AirTable
read served by the mesonet-db-rds API (`api/app/app/registry.py` there; 300 s
cache). The page is cross-origin to the API everywhere — GitHub Pages origin and
the `mesonet.climate.umt.edu/maintenance/` proxy alike — so `API_BASE` must
also be listed in the meta CSP `connect-src`, and the API must keep answering
with CORS `*`. If the API host changes, change both.

Visit photos are AirTable attachments on `*.airtableusercontent.com`. Those
URLs appear only in the API response, never in the HTML, so `img-src` carries
the wildcarded host; a blocked CSS `background-image` renders as an empty box,
not a console error, so re-check thumbnails after any CSP edit.

## Deploying — read before you push

Pushing `main` **is a production deploy, on two URLs**: GitHub Pages publishes
the repo root from `main`, and the same page is reverse-proxied at
`mesonet.climate.umt.edu/maintenance/` (mesonet_app Caddyfile on the legacy
host; `pages_apps` in mesonet-edge terraform on the CloudFront host). The old
`/api/v2/map/maintenance/` path 301s here from the mesonet-db-rds API.

## Verification

There is no CI for the page. Before any push, run the manual gates from
mco-web-style `MIGRATING.md` § "Verification recipe": `node --check app.js`,
`npx html-validate@9 index.html`, and the app's `consumer-verify.mjs` harness
(untracked; install `playwright` + `@axe-core/playwright` with `--no-save`).

The harness serves the repo root on a local port and intercepts the two API URLs
in the browser (`ctx.route`) to answer them from `fixtures/` — also untracked,
because Pages serves everything committed and fake station data must never be
public. The generator is in the harness header comment; captures of the live
endpoints (`curl` with `?type=json`) work too. `renderEvidence` must be a
**function**, not a string: a string is `eval`'d in-page and the CSP has no
`'unsafe-eval'`.

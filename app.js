/* ==========================================================================
   Mesonet Station Maintenance — application code.

   Classic script, NOT a module: the kit ships mco-core.js / mco-map.js as
   plain globals (MCO, MCO.map), and a classic script keeps this file in the
   same execution mode. Loaded at the end of <body>, after the kit, so the
   DOM and every kit global are already there. MapLibre 6 is NOT: it is an
   ES module the kit imports on demand, so the UI is wired first and the map
   is built in initMap() once MCO.map.loadMapLibre() resolves (kit 0.8.0+).

   Extracted from the inline <script type="module"> during the mco-web-style
   migration (kit @0.6.0) — an external file is what lets the page ship a
   meta CSP without 'unsafe-inline'.
   ========================================================================== */
(function () {
  'use strict';

  // ── Constants ────────────────────────────────────────────────────────────
  // Absolute: this page is a static GitHub Pages site (proxied at
  // mesonet.climate.umt.edu/maintenance/), so the API is always cross-origin.
  // The maintenance feed is a live AirTable read that only the mesonet-db-rds
  // API serves; it answers with CORS `*`. The host must also appear in the
  // meta CSP connect-src in index.html.
  const API_BASE     = 'https://mesonet2.climate.umt.edu/api/v2';
  const STATIONS_URL = `${API_BASE}/stations/?type=json`;
  const MAINT_URL    = `${API_BASE}/stations/maintenance/live?type=json`;
  const DASH_URL     = (s) => `https://mesonet.climate.umt.edu/dash/${encodeURIComponent(s)}`;


  // Spider geometry / interaction
  const SPIDER_RADIUS_PX        = 26;     // distance from anchor to spider foot
  const SPIDER_CLOSE_GRACE_MS   = 250;    // hover gap when cursor leaves one of the spider layers
  const SEARCH_FLY_ZOOM         = 11;     // zoom when search/deep-link flies to a station
  const SEARCH_FLY_SPEED        = 1.4;
  // Label collision detection switches on at this zoom
  const LABEL_MINZOOM           = 6;
  // Reservation name labels switch on at this zoom (less cluttered at MT extent)
  const TRIBAL_LABEL_MINZOOM    = 7;
  // Coordinate precision for the co-location bucket key (~11 m at MT latitudes)
  const BUCKET_PRECISION        = 4;

  // Trip-type precedence (first match on last_trip_type wins) for triptype mode.
  const TRIP_PRECEDENCE = ['Maintenance', 'Repair', 'Ground Game', 'Structure Install', 'Tech Install'];

  const NULL_COLOR = '#9aa3b3';

  // Mode configs. Each mode = a catKey (the GeoJSON property the legend/filter/
  // paint key on), a legend title, and ordered categories (key, color, label).
  const MODES = {
    compliance: {
      catKey: 'complianceState',
      legendTitle: 'HydroMet requirement (this year)',
      cats: [
        { key: 'visited',   color: '#2a8a86', label: 'Visited this year' },
        { key: 'overdue',   color: '#b8421b', label: 'Overdue' },
        { key: 'new',       color: '#5aaee8', label: 'New this year (exempt)' },
        { key: 'as_needed', color: '#7a8ba6', label: 'AgriMet (as-needed)' },
        // 'nodata' only occurs on a total fetch failure (every station at once,
        // covered by the banner). Kept for paint/filter but hidden from the legend.
        { key: 'nodata',    color: '#9aa3b3', label: 'No data', hidden: true },
      ],
    },
    timesince: {
      catKey: 'timeBinKey',
      legendTitle: 'Since last Maintenance',
      // Crameri "roma" (Kyle's decision, 2026-10-09/10: the family's recency
      // ramp, the same five stops as mesonet-status's time-since bins, so the
      // two maps read alike). Diverging and CVD-safe, teal = fresh → red =
      // stale, sampled toward the centre so both ends stay vivid. The kit's
      // MCO.palette has no roma (only cyclic romaO), so the stops are listed
      // here as data colors (§6). Accepted with the decision: lightness isn't
      // monotonic, and some fills sit under 3:1 on --bg-surface (dark: > 1
      // year 2.81; light: 1–3 mo 2.06, 3–6 mo 1.39, 6–12 mo 2.81). The kit's
      // --dot-stroke outline carries the edge instead: 14–21:1 against the
      // surface in every theme.
      cats: [
        { key: '0',    color: '#2a8a86', label: '< 1 month' },
        { key: '1',    color: '#84c2a0', label: '1–3 months' },
        { key: '2',    color: '#f4d88e', label: '3–6 months' },
        { key: '3',    color: '#d4894a', label: '6–12 months' },
        { key: '4',    color: '#b8421b', label: '> 1 year' },
        { key: 'null', color: '#9aa3b3', label: 'Never / no data' },
      ],
    },
    triptype: {
      catKey: 'tripTypeKey',
      legendTitle: 'Most recent trip type',
      cats: [
        // Reverse of the natural work order (Ground Game → Structure → Tech →
        // Repair → Maintenance), so Maintenance sits on top.
        { key: 'Maintenance',       color: '#2a8a86', label: 'Maintenance' },
        { key: 'Repair',            color: '#b8421b', label: 'Repair' },
        { key: 'Tech Install',      color: '#e0a32e', label: 'Tech Install' },
        { key: 'Structure Install', color: '#b07fd0', label: 'Structure Install' },
        { key: 'Ground Game',       color: '#5aaee8', label: 'Ground Game' },
        { key: 'Other',             color: '#9aa3b3', label: 'Other / none' },
      ],
    },
  };
  const MODE_NAMES = Object.keys(MODES);

  const bucketKey = (lat, lon) =>
    `${lat.toFixed(BUCKET_PRECISION)},${lon.toFixed(BUCKET_PRECISION)}`;

  // ── DOM refs ─────────────────────────────────────────────────────────────
  const refreshStampEl= document.getElementById('refresh-stamp');
  const subnetFiltersEl = document.getElementById('subnet-filters');
  const legendRowsEl  = document.getElementById('legend-rows');
  const legendTitleEl = document.getElementById('legend-title');
  const searchInput   = document.getElementById('search-input');
  const searchList    = document.getElementById('search-dropdown');
  const infoModal     = document.getElementById('info-modal');
  const mapContainerEl = document.getElementById('map-container');

  // Tell screen-reader users which station opened when a popup is shown via
  // click, search, or deep-link. MCO.announce (kit 0.8.0) owns the polite
  // live region, its clear-then-set (so a repeat is re-read) and de-dupe.
  function announcePopup(stationId) {
    const s = stationById.get(stationId);
    if (!s) return;
    const state = complianceStateFor(s);
    const pill = STATE_PILL[state] || STATE_PILL.overdue;
    MCO.announce(`${s.name} (${s.station}), ${s.sub_network || 'station'}, ${pill.lbl}.`);
  }

  // ── Theme ────────────────────────────────────────────────────────────────
  // High-contrast is a dark-family theme, so these test `!== 'light'` rather
  // than `=== 'dark'`. The old `=== 'dark'` form is exactly what dropped a
  // high-contrast viewer onto the light basemap and the light dot stroke.
  const isDark = () => MCO.getTheme() !== 'light';
  function dotStrokeColor() {
    // --dot-stroke is a kit token precisely because every MCO map needs a
    // marker outline that survives all three themes.
    return getComputedStyle(document.documentElement)
      .getPropertyValue('--dot-stroke').trim() || (isDark() ? '#ffffff' : '#2a2a3a');
  }

  MCO.initThemeToggle({
    button:   document.getElementById('btn-theme'),
    iconSun:  document.getElementById('icon-sun'),
    iconMoon: document.getElementById('icon-moon'),
    // 0.10.0: dark -> light -> high contrast, so high contrast is reachable
    // from the page, not only from ?theme= or storage.
    cycle: true,
    iconContrast: document.getElementById('icon-contrast'),
  });
  // React to the theme however it changed (this button, or any other
  // MCO.setTheme caller): the kit's mco:themechange event (0.9.0), not the
  // toggle's onChange. The every-style.load handler in wireMapLoad() re-adds
  // our layers and re-samples the ramp colors for the new theme.
  document.addEventListener('mco:themechange', () => {
    if (map) map.setStyle(MCO.map.cartoStyleUrl());
    writeUrl();
  });

  // ── Info modal ───────────────────────────────────────────────────────────
  // The kit owns backdrop-click, [data-close-modal] delegation, and
  // opener-captured focus restore.
  const btnInfo = document.getElementById('btn-info');
  const infoModalCtl = MCO.initInfoModal({ dialog: infoModal, trigger: btnInfo });

  // Mark the intro seen AT OPEN, not on close. Someone who reads the modal and
  // navigates away without closing it has still seen it; the old close-handler
  // version re-opened the intro for that visitor on every single visit.
  const markIntroSeen = () => MCO.lsSet('mco-maint-seen-intro', '1');
  btnInfo.addEventListener('click', markIntroSeen);

  // First-visit auto-open: show the help on load so a new visitor knows what
  // the colors mean. A deep link means they were sent to something specific —
  // don't bury it under the intro.
  const _bootParams = MCO.urlParams();
  const _isDeepLink = ['station', 'lng', 'lat', 'zoom']
    .some((k) => _bootParams.has(k));
  if (!MCO.lsGet('mco-maint-seen-intro') && !_isDeepLink) {
    // Defer one tick so the page is rendered before the dialog steals focus.
    setTimeout(() => {
      if (!infoModal.open) { infoModalCtl.open(); markIntroSeen(); }
    }, 350);
  }

  // ── Date / time helpers ──────────────────────────────────────────────────
  // The Mesonet network is in Montana and maintenance "Visit Date" values are
  // Montana-local calendar dates. Relative labels ("today"/"yesterday") are
  // therefore computed against the current date in Montana — not the viewer's
  // timezone and not UTC — so a visit logged today reads "today" no matter what
  // time of day (or from which timezone) the map is viewed.
  const MT_TZ = 'America/Denver';
  // Parse a date-only ISO string ("YYYY-MM-DD") to a Date at *local* midnight.
  // Both sides of the day-count below are built this way, so their difference is
  // a whole number of calendar days (DST-safe via the round on the result).
  function ymdToLocalMidnight(iso) {
    const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d);
  }
  // "Today" as a local-midnight Date, but for the calendar date currently in
  // Montana. en-CA formats as YYYY-MM-DD, which we re-parse to local midnight.
  function montanaToday() {
    const iso = new Intl.DateTimeFormat('en-CA', {
      timeZone: MT_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    return ymdToLocalMidnight(iso);
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
  }
  function relDays(iso) {
    if (!iso) return '';
    const visit = ymdToLocalMidnight(iso);
    if (!visit) return '';
    // Whole calendar days between the two local midnights (round absorbs the
    // 23h/25h DST days that would otherwise make a diff land on x.96 or x.04).
    const days = Math.round((montanaToday() - visit) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 60) return `${days} days ago`;
    const mo = days / 30.4;
    if (mo < 24) return `${Math.round(mo)} months ago`;
    return `${(days / 365).toFixed(1)} years ago`;
  }
  function refreshStamp() {
    // Mountain Time, not viewer-local. This is an operations map for a Montana
    // network: "loaded 14:05" has to mean the same clock to a field tech in
    // Bozeman and a collaborator in DC (HOUSE-STYLE § time).
    refreshStampEl.textContent = `loaded ${MCO.hhmmNowMT()} MT`;
  }

  // Discrete time-since bin key from days_since_qualifying (applies to all
  // networks in timesince mode). Strings, so the same value type covers all
  // modes in URL params + filters.
  function timeBinKey(days) {
    if (days == null) return 'null';
    if (days < 30)  return '0';
    if (days < 90)  return '1';
    if (days < 180) return '2';
    if (days < 365) return '3';
    return '4';
  }
  function tripTypeKey(arr) {
    if (!arr || !arr.length) return 'Other';
    for (const t of TRIP_PRECEDENCE) if (arr.includes(t)) return t;
    return 'Other';
  }
  // ── Compliance (HydroMet-only annual requirement) ─────────────────────────
  // Computed in the frontend because it needs sub_network. Applies ONLY to
  // compliance mode; timesince/triptype color AgriMet normally.
  // Use Montana's current calendar year (see montanaToday) so the annual
  // requirement flips over at midnight Montana time, consistent with relDays.
  const CURRENT_YEAR = montanaToday().getFullYear();
  function installedThisYear(s) {
    if (s.date_installed == null) return false;
    // Parse the install date's year in Montana time when it's a date-only
    // string; fall back to a plain Date for any other shape (e.g. epoch ms).
    const asMidnight = ymdToLocalMidnight(s.date_installed);
    const d = asMidnight || new Date(s.date_installed);
    return !isNaN(d.getTime()) && d.getFullYear() === CURRENT_YEAR;
  }
  function complianceStateFor(s) {
    if (dataUnavailable) return 'nodata';
    if (s.sub_network !== 'HydroMet') return 'as_needed';
    const m = maintBySta.get(s.station);
    if (m && m.visited_this_year) return 'visited';
    if (installedThisYear(s)) return 'new';   // built this year → exempt, not overdue
    return 'overdue';
  }

  // ── State ────────────────────────────────────────────────────────────────
  let stations    = [];                       // raw /stations response
  let maintBySta  = new Map();                // station slug → maintenance summary
  let stationById = new Map();                // station slug → meta object
  let bucketById  = new Map();                // station slug → bucket key
  let dataUnavailable = false;                // true if the maintenance fetch failed/empty
  // Dynamic colocation indices — recomputed every rebuildSource() based on
  // the currently-visible sub-networks. Hidden-network stations are excluded.
  let bucketSize    = new Map();              // bucket key → visible count
  let bucketIndex   = new Map();              // station slug → index within visible members (0..n-1)
  let bucketAnchor  = new Map();              // bucket key → visible anchor station slug
  let bucketMembers = new Map();              // bucket key → [station metadata in display order]
  let _spiderBucket = null;                   // bucket key currently spidered, or null
  let _popup = null;
  let _mapReady = false;
  // Cached static overlay FeatureCollections — fetched once, reused across
  // every setStyle() (the source is re-added but data stays in memory).
  let _tribalFC = null;
  let _stateFC  = null;
  async function preloadOverlay(sourceId, url, save) {
    try {
      const fc = await MCO.fetchJSON(url);
      save(fc);
      // If the source still has the URL data (initial load), swap to the
      // in-memory copy so subsequent re-adds don't refetch.
      const src = map.getSource(sourceId);
      if (src) src.setData(fc);
    } catch { /* overlays are decorative — silent failure is fine */ }
  }

  // ── URL state ────────────────────────────────────────────────────────────
  // URL params take precedence over localStorage take precedence over defaults.
  // All enum-string values are matched case-insensitively. Lists may be separated
  // by spaces (which '+' decodes to via URLSearchParams), commas, or both.
  // Read once at boot. getLower / splitTokens are the kit's — this file used to
  // carry byte-identical copies of both.
  const urlParams = MCO.urlParams();
  const getLower = (key) => MCO.getParamLower(key, urlParams);
  const splitTokens = MCO.splitTokens;

  // Lowercase → canonical lookup for the two known sub-networks. (The API uses
  // mixed-case strings; URL params are lowercase.)
  const KNOWN_NETWORKS = ['HydroMet', 'AgriMet'];
  const networkByLowerName = new Map(KNOWN_NETWORKS.map(n => [n.toLowerCase(), n]));

  let activeMode = (() => {
    const u = getLower('mode');
    if (u && MODES[u]) return u;
    const saved = MCO.lsGet('mco-maint-mode');
    return (saved && MODES[saved]) ? saved : 'compliance';
  })();

  let activeNetworks = (() => {
    const tokens = splitTokens(urlParams.get('net'));
    if (tokens !== null) {
      return new Set(tokens.map(t => networkByLowerName.get(t)).filter(Boolean));
    }
    try {
      const saved = JSON.parse(MCO.lsGet('mco-maint-networks') || 'null');
      if (Array.isArray(saved)) return new Set(saved);
    } catch {}
    return new Set();
  })();

  // ?kbd=off disables the single-character '/' shortcut (WCAG 2.1.4 — a
  // speech-input user can misfire it just by dictating a sentence). Read up
  // here with the rest of the URL state, not down in the keyboard section:
  // writeUrl() emits it and can run during init, which would put a late
  // `const` in its temporal dead zone.
  const kbdShortcuts = getLower('kbd') !== 'off';

  const _initLng    = parseFloat(urlParams.get('lng'));
  const _initLat    = parseFloat(urlParams.get('lat'));
  const _initZoom   = parseFloat(urlParams.get('zoom'));
  const _hasInitPos = Number.isFinite(_initLng) && Number.isFinite(_initLat) && Number.isFinite(_initZoom);
  // Station IDs in the API are already lowercase; normalize the URL param too.
  const _initStation = getLower('station');

  // ── Legend category visibility (Plotly-style toggles) ────────────────────
  // Each mode has its own visible-category set. Missing URL param = all visible.
  // The URL param name for a mode's cat set is `cat-<mode>` (e.g. cat-compliance).
  const catParamKey = (mode) => `cat-${mode}`;
  function allCatKeys(mode) { return MODES[mode].cats.map(c => c.key); }
  function parseCatSet(mode) {
    const allKeys = allCatKeys(mode);
    const tokens = splitTokens(urlParams.get(catParamKey(mode)));
    if (tokens === null) return new Set(allKeys);
    // Case-insensitive match against the mode's keys.
    const lowerToKey = new Map(allKeys.map(k => [k.toLowerCase(), k]));
    const set = new Set(tokens.map(t => lowerToKey.get(t)).filter(Boolean));
    return set.size ? set : new Set();   // an explicit empty list = nothing visible
  }
  // One visible-category set per mode.
  const visibleCatsByMode = {};
  for (const mode of MODE_NAMES) visibleCatsByMode[mode] = parseCatSet(mode);
  function currentCats()    { return visibleCatsByMode[activeMode]; }
  function currentAllCats() { return allCatKeys(activeMode); }
  function currentCatKey()  { return MODES[activeMode].catKey; }

  let _selectedStation = _initStation;

  // ── Map init ─────────────────────────────────────────────────────────────
  // `map` stays null until MapLibre 6 has been imported (see Boot, at the
  // bottom). Everything a control can reach before then checks for it.
  let map = null;
  let zoomFloor = null;
  function initMap() {
    map = new maplibregl.Map({
      container: 'map',
      style: MCO.map.cartoStyleUrl(),
      ...MCO.map.initialCamera(urlParams),
    });
    MCO.map.addNavigation(map);                 // zoom buttons, no compass
    // onBeforeFit closes the spider: fitting out to the whole state while a
    // cluster is exploded would leave its legs drawn across empty map.
    MCO.map.addFitControl(map, { onBeforeFit: () => closeSpider() });
    wireMapLoad();
    wireMapClick();
    wireMapHover();
  }

  function addCustomLayers() {
    if (!map.getSource('stations')) {
      map.addSource('stations', { type: 'geojson', data: emptyFC() });
    }
    if (!map.getSource('spider')) {
      map.addSource('spider', { type: 'geojson', data: emptyFC() });
    }
    if (!map.getSource('spider-lines')) {
      map.addSource('spider-lines', { type: 'geojson', data: emptyFC() });
    }
    // Static overlay data (reservations + state outline): fetched once on first
    // load, then reused across setStyle() so theme toggle doesn't refetch.
    if (!map.getSource('tribal')) {
      map.addSource('tribal', {
        type: 'geojson',
        data: _tribalFC || 'data/mt_reservations_simple.geojson',
      });
    }
    if (!map.getSource('state')) {
      map.addSource('state', {
        type: 'geojson',
        data: _stateFC || 'data/mt_state_simple.geojson',
      });
    }
    if (!_tribalFC) preloadOverlay('tribal', 'data/mt_reservations_simple.geojson', fc => _tribalFC = fc);
    if (!_stateFC)  preloadOverlay('state',  'data/mt_state_simple.geojson',         fc => _stateFC  = fc);

    // Themed live-shaded topography, underneath everything we draw. On a map
    // of point stations the terrain is genuinely useful context — which
    // stations sit in valleys, which on ridges — and nothing here covers it.
    MCO.map.addHillshade(map);

    // CARTO draws its own dashed county boundaries (pale orange on Positron,
    // z9+). They compete with the tribal outlines this map does draw, and
    // can't be turned off, so hide them. Re-run on every style load, because
    // setStyle brings them back.
    if (map.getLayer('boundary_county')) {
      map.setLayoutProperty('boundary_county', 'visibility', 'none');
    }

    // Tribal-land fill + outline sit below all our station layers so the dots
    // always read as primary. The matching label layer is added last (on top).
    if (!map.getLayer('tribal-fill')) {
      map.addLayer({
        id: 'tribal-fill', type: 'fill', source: 'tribal',
        paint: tribalFillPaint(),
      });
    }
    if (!map.getLayer('tribal-line')) {
      map.addLayer({
        id: 'tribal-line', type: 'line', source: 'tribal',
        paint: tribalLinePaint(),
      });
    }
    // Montana state boundary — heavier line so the state shape reads as the
    // dominant frame. No fill (the basemap already provides context). Sits
    // above tribal so it's the strongest boundary, below stations so dots win.
    if (!map.getLayer('state-line')) {
      map.addLayer({
        id: 'state-line', type: 'line', source: 'state',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: stateLinePaint(),
      });
    }

    if (!map.getLayer('spider-lines-layer')) {
      map.addLayer({
        id: 'spider-lines-layer', type: 'line', source: 'spider-lines',
        paint: {
          'line-color': ['get', '_strokeColor'],
          'line-width': 1.2,
          'line-opacity': 0.65,
        },
      });
    }

    if (!map.getLayer('stations-layer')) {
      map.addLayer({
        id: 'stations-layer', type: 'circle', source: 'stations',
        // Filter is set by applyAllFilters() at the end of this function.
        paint: stationPaint(),
      });
    }

    if (!map.getLayer('stations-badge')) {
      map.addLayer({
        id: 'stations-badge', type: 'symbol', source: 'stations',
        layout: {
          'text-field': ['to-string', ['get', 'colocationCount']],
          'text-font':  ['Open Sans Bold', 'Arial Unicode MS Bold'],
          'text-size':  10,
          'text-offset': [0, -1.05],
          'text-anchor': 'bottom',
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': '#1a1a2e',
          'text-halo-width': 1.2,
        },
      });
    }

    if (!map.getLayer('stations-id-label')) {
      map.addLayer({
        id: 'stations-id-label', type: 'symbol', source: 'stations',
        minzoom: LABEL_MINZOOM,
        layout: stationLabelLayout(),
        paint: stationLabelPaint(),
      });
    }

    if (!map.getLayer('spider-layer')) {
      map.addLayer({
        id: 'spider-layer', type: 'circle', source: 'spider',
        paint: stationPaint(),
      });
    }

    if (!map.getLayer('spider-id-label')) {
      map.addLayer({
        id: 'spider-id-label', type: 'symbol', source: 'spider',
        layout: stationLabelLayout(),
        paint: stationLabelPaint(),
      });
    }

    // Reservation name labels — drawn last so they sit above station dots.
    // Minzoom keeps the map uncluttered at state-extent zoom.
    if (!map.getLayer('tribal-label')) {
      map.addLayer({
        id: 'tribal-label', type: 'symbol', source: 'tribal',
        minzoom: TRIBAL_LABEL_MINZOOM,
        // The Census-name → common-usage mapping and the whole type treatment
        // moved into the kit as MCO.map.TRIBAL_LABEL_LAYOUT; this page's copy
        // was its source and matched it exactly.
        layout: MCO.map.TRIBAL_LABEL_LAYOUT,
        paint: tribalLabelPaint(),
      });
    }

    applyAllFilters();
    refreshDotColors();
    applyLabelsVisibility();
  }

  function emptyFC() { return { type: 'FeatureCollection', features: [] }; }

  // ── Paint expression generators ──────────────────────────────────────────
  // Simple match on the active mode's catKey → its category colors.
  function paintColorForMode(mode) {
    const m = MODES[mode];
    const expr = ['match', ['get', m.catKey]];
    for (const c of m.cats) expr.push(c.key, c.color);
    expr.push(NULL_COLOR);   // fallback
    return expr;
  }

  function stationPaint() {
    return {
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        4,  3.5,
        7,  5,
        10, 7,
        14, 9,
      ],
      'circle-color': paintColorForMode(activeMode),
      'circle-stroke-color': dotStrokeColor(),
      'circle-stroke-width': 1.2,
      'circle-opacity': 0.95,
    };
  }

  function stationLabelLayout() {
    return {
      'text-field': ['get', 'station'],
      'text-font':  ['Open Sans Regular', 'Arial Unicode MS Regular'],
      'text-size':  [
        'interpolate', ['linear'], ['zoom'],
        6,  9,
        10, 11,
        14, 12,
      ],
      // Try anchor positions in order until one fits without colliding.
      'text-variable-anchor': ['left', 'right', 'top', 'bottom', 'top-left', 'top-right', 'bottom-left', 'bottom-right'],
      'text-radial-offset': 0.9,
      'text-justify': 'auto',
      'text-padding': 2,
      'text-allow-overlap': false,
      'text-ignore-placement': false,
      'text-optional': true,    // hide rather than show colliding labels
    };
  }
  function stationLabelPaint() {
    const dark = document.documentElement.dataset.theme !== 'light';
    return {
      'text-color':      dark ? '#e8ecf0' : '#1a1a2e',
      'text-halo-color': dark ? '#161b22' : '#ffffff',
      'text-halo-width': 1.4,
      'text-halo-blur':  0.4,
    };
  }
  function refreshLabelPaint() {
    if (!map || !map.getLayer('stations-id-label')) return;
    const p = stationLabelPaint();
    for (const lid of ['stations-id-label', 'spider-id-label']) {
      if (!map.getLayer(lid)) continue;
      map.setPaintProperty(lid, 'text-color',      p['text-color']);
      map.setPaintProperty(lid, 'text-halo-color', p['text-halo-color']);
    }
  }

  // Tribal-lands styling — subtle earthy fill, theme-aware. Sandstone hues
  // chosen for low chroma so the colored station dots remain primary.
  // These three were byte-identical to MCO.map.overlayPaints() — this map is
  // where the kit's values came from in the first place. Consuming them back
  // means a future adjustment lands here too, instead of leaving one fork
  // behind.
  function tribalFillPaint()  { return MCO.map.overlayPaints().tribalFill; }
  function tribalLinePaint()  { return MCO.map.overlayPaints().tribalLine; }
  function tribalLabelPaint() { return MCO.map.overlayPaints().tribalLabelPaint; }
  function refreshTribalPaint() {
    if (!map.getLayer('tribal-fill')) return;
    const fp = tribalFillPaint();
    map.setPaintProperty('tribal-fill', 'fill-color',   fp['fill-color']);
    map.setPaintProperty('tribal-fill', 'fill-opacity', fp['fill-opacity']);
    const lp = tribalLinePaint();
    map.setPaintProperty('tribal-line', 'line-color',   lp['line-color']);
    map.setPaintProperty('tribal-line', 'line-opacity', lp['line-opacity']);
    const tp = tribalLabelPaint();
    map.setPaintProperty('tribal-label', 'text-color',      tp['text-color']);
    map.setPaintProperty('tribal-label', 'text-halo-color', tp['text-halo-color']);
  }

  // Montana state outline — heavier than the tribal lines so it reads as the
  // primary boundary on the map. Also byte-identical to the kit's shared
  // boundary treatment, so it consumes that instead of keeping a fork.
  function stateLinePaint() { return MCO.map.overlayPaints().stateLine; }
  function refreshStatePaint() {
    if (!map.getLayer('state-line')) return;
    const p = stateLinePaint();
    map.setPaintProperty('state-line', 'line-color',   p['line-color']);
    map.setPaintProperty('state-line', 'line-opacity', p['line-opacity']);
  }

  function refreshDotColors() {
    if (!map || !map.getLayer('stations-layer')) { renderLegend(); return; }
    const color = paintColorForMode(activeMode);
    const stroke = dotStrokeColor();
    for (const lid of ['stations-layer', 'spider-layer']) {
      map.setPaintProperty(lid, 'circle-color', color);
      map.setPaintProperty(lid, 'circle-stroke-color', stroke);
    }
    refreshLabelPaint();
    refreshTribalPaint();
    refreshStatePaint();
    // Spider connector line color also follows theme
    if (map.getLayer('spider-lines-layer')) {
      // _strokeColor is per-feature; refresh source data so the new color is baked in
      rebuildSpider();
    }
    renderLegend();
  }

  // ── Data fetch ───────────────────────────────────────────────────────────
  // Maintenance data changes slowly: load once on map load (or via manual
  // Refresh). Fetch BOTH endpoints, then JOIN by station slug.
  async function loadAll() {
    try {
      // The maintenance feed is optional — the map still works as a station
      // map without it, so a failure there degrades to the banner rather than
      // taking the whole load down with it.
      const [st, maintRaw] = await Promise.all([
        MCO.fetchJSON(STATIONS_URL, { cache: 'no-store' }),
        MCO.fetchJSON(MAINT_URL,    { cache: 'no-store' }).catch(() => null),
      ]);
      stations = st;

      const maint = Array.isArray(maintRaw) ? maintRaw : [];
      dataUnavailable = maint.length === 0;
      maintBySta = new Map(maint.map(m => [m.station, m]));
      setDataNotice(dataUnavailable);

      indexStations();
      buildFilterUI();
      searchBox.refresh();
      rebuildSource();
      applyAllFilters();   // re-apply now that activeNetworks is populated
      renderLegend();
      refreshStamp();
      // Deep-link from ?station=… in URL. loadAll() is only called from the
      // map's 'load' handler (and Refresh), so _mapReady is always true here.
      if (_initStation && stationById.has(_initStation)) {
        const s = stationById.get(_initStation);
        if (_hasInitPos) openPopupFor(_initStation, [s.longitude, s.latitude]);
        else             flyToAndOpen(_initStation);
        _initStationConsumed = true;
      } else {
        // Push initial URL so it's clean even if the user hasn't interacted yet
        writeUrl();
      }
      // First meaningful state is on screen: release the kit's first-paint
      // hold (0.9.0). Idempotent, so Refresh calling it again is harmless.
      MCO.ready();
    } catch (err) {
      console.error(err);
      dataUnavailable = true;
      setDataNotice(true);
      MCO.showToast(`Error loading data: ${err.message}`);
      // Still try to render whatever we have.
      indexStations();
      buildFilterUI();
      searchBox.refresh();
      rebuildSource();
      applyAllFilters();
      renderLegend();
      MCO.ready();
    }
  }
  // Maintenance feed down or empty: a warning notice over the map, with
  // Retry (MCO.notice, kit 0.8.0 — tone word, icon, announcement, dismiss).
  // The element keeps the id "data-banner": scripts/generate_preview.py
  // refuses to overwrite the social card while it is visible.
  let _dataNotice = null;
  function setDataNotice(on) {
    if (on && !_dataNotice) {
      _dataNotice = MCO.notice({
        tone: 'warning',
        text: 'Maintenance data unavailable. Showing stations without visit status.',
        action: { label: 'Retry', onClick: () => refreshData() },
        container: mapContainerEl, place: 'over',
        onClose: () => { _dataNotice = null; },
      });
      if (_dataNotice.element) _dataNotice.element.id = 'data-banner';
    } else if (!on && _dataNotice) {
      const n = _dataNotice;
      _dataNotice = null;
      n.close();
    }
  }
  // Only re-consume the deep-link once (initial load); Refresh shouldn't refly.
  let _initStationConsumed = false;

  // Network priority for choosing a bucket anchor; tiebreak by station id.
  const netRank = (s) => s === 'HydroMet' ? 0 : s === 'AgriMet' ? 1 : 99;

  // Static index: each station's lat/lon-derived bucket key + metadata lookup.
  // Co-location structure (count, anchor, index) is recomputed dynamically in
  // rebuildSource() based on the currently-visible sub-networks — so disabling
  // a network resolves a 2-stack to a single un-badged dot.
  function indexStations() {
    stationById.clear();
    bucketById.clear();
    for (const s of stations) {
      const lat = Number(s.latitude), lon = Number(s.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      // Normalize to numbers so downstream geometry / project() is happy.
      s.latitude = lat; s.longitude = lon;
      stationById.set(s.station, s);
      bucketById.set(s.station, bucketKey(lat, lon));
    }
    // Initialize sub-network filter set if empty (no URL or localStorage value)
    const allNetworks = new Set(stations.map(s => s.sub_network).filter(Boolean));
    if (activeNetworks.size === 0) {
      activeNetworks = new Set(allNetworks);
    } else {
      for (const n of [...activeNetworks]) if (!allNetworks.has(n)) activeNetworks.delete(n);
      if (activeNetworks.size === 0) activeNetworks = new Set(allNetworks);
    }
  }

  // Build the per-feature category properties for a station meta object.
  function featurePropsFor(s) {
    const m = maintBySta.get(s.station);
    const days = (m && !dataUnavailable) ? m.days_since_qualifying : null;
    const lastTT = (m && !dataUnavailable) ? (m.last_trip_type || []) : [];
    return {
      complianceState: complianceStateFor(s),
      timeBinKey:      dataUnavailable ? 'null' : timeBinKey(days),
      tripTypeKey:     dataUnavailable ? 'Other' : tripTypeKey(lastTT),
    };
  }

  function rebuildSource() {
    if (!map || !map.getSource('stations')) return;

    // Group visible-network stations by bucket and (re)compute colocation per
    // the currently-visible set. This both filters out hidden-network stations
    // at source-emit time AND re-ranks anchors so a HydroMet hide promotes the
    // AgriMet station to anchor (or, if alone in its bucket, treats it as a
    // single non-co-located dot — no badge, no spider).
    bucketMembers.clear();
    bucketSize.clear();
    bucketAnchor.clear();
    bucketIndex.clear();

    for (const s of stations) {
      if (!stationById.has(s.station)) continue;             // missing lat/lon, skipped at index time
      if (s.sub_network && !activeNetworks.has(s.sub_network)) continue;
      const k = bucketById.get(s.station);
      let arr = bucketMembers.get(k);
      if (!arr) { arr = []; bucketMembers.set(k, arr); }
      arr.push(s);
    }
    for (const [k, members] of bucketMembers) {
      members.sort((a, b) =>
        netRank(a.sub_network) - netRank(b.sub_network) ||
        a.station.localeCompare(b.station));
      bucketSize.set(k, members.length);
      bucketAnchor.set(k, members[0].station);
      members.forEach((s, i) => bucketIndex.set(s.station, i));
    }

    const features = [];
    for (const [k, members] of bucketMembers) {
      for (const s of members) {
        const cats = featurePropsFor(s);
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [s.longitude, s.latitude] },
          properties: {
            station:         s.station,
            name:            s.name,
            sub_network:     s.sub_network,
            complianceState: cats.complianceState,
            timeBinKey:      cats.timeBinKey,
            tripTypeKey:     cats.tripTypeKey,
            colocationCount: members.length,
            colocationIndex: bucketIndex.get(s.station),
            bucket:          k,
          },
        });
      }
    }
    map.getSource('stations').setData({ type: 'FeatureCollection', features });

    rebuildSrTable(features);

    // If a spider is open, refresh its feet — the bucket's anchor or membership
    // may have just changed.
    if (_spiderBucket) rebuildSpider();
  }

  // Screen-reader twin of the canvas. WebGL paints to a bitmap assistive tech
  // cannot read at all, so without this the map's entire content is invisible
  // to a non-sighted user (HOUSE-STYLE §5). Built from the very features the
  // map just drew, so the two cannot disagree — the network filter included,
  // since hidden-network stations never reach `features`. Rebuilt silently: it
  // is deliberately NOT wired to a live region, because re-announcing the whole
  // table on every repaint would be noise.
  // MCO.srTable (kit 0.8.0): the wrapper div carries .sr-only, not the
  // <table>. The old hand-built table had .sr-only on the <table> itself,
  // which a table ignores for sizing: it laid out ~614px wide, and on a
  // mobile browser that widened the layout viewport past the screen.
  const srTwin = MCO.srTable({
    container: document.getElementById('main'),
    caption: 'Mesonet stations and their maintenance-visit status',
    columns: [
      { key: 'name', label: 'Station', rowHeader: true },
      { key: 'station', label: 'ID' },
      { key: 'net', label: 'Sub-network' },
      { key: 'status', label: 'Status' },
      { key: 'last', label: 'Last visit' },
    ],
    rowKey: (r) => r.station,
  });
  srTwin.element.id = 'sr-station-table';
  function rebuildSrTable(features) {
    const rows = features
      .map((f) => {
        const p = f.properties;
        const m = maintBySta.get(p.station);
        const pill = STATE_PILL[p.complianceState] || STATE_PILL.nodata;
        return {
          name: p.name, station: p.station, net: p.sub_network,
          status: pill.lbl,
          last: m && m.last_visit_date ? fmtDate(m.last_visit_date) : null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    srTwin.render(rows);
  }

  // ── Sub-network filter UI (chip toggles in navbar) ───────────────────────
  function buildFilterUI() {
    const allNetworks = [...new Set(stations.map(s => s.sub_network).filter(Boolean))].sort();
    const byNet = {};
    for (const s of stations) {
      if (!s.sub_network) continue;
      byNet[s.sub_network] = (byNet[s.sub_network] || 0) + 1;
    }
    subnetFiltersEl.innerHTML = '';
    for (const net of allNetworks) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'mco-chip';
      chip.dataset.network = net;
      chip.setAttribute('aria-pressed', activeNetworks.has(net) ? 'true' : 'false');
      const lbl = document.createElement('span');
      lbl.textContent = net;
      const count = document.createElement('span');
      count.className = 'mco-chip-count';
      count.dataset.network = net;
      count.textContent = String(byNet[net] || 0);
      chip.appendChild(lbl);
      chip.appendChild(count);
      chip.addEventListener('click', () => {
        const on = chip.getAttribute('aria-pressed') !== 'true';
        chip.setAttribute('aria-pressed', on ? 'true' : 'false');
        if (on) activeNetworks.add(net);
        else    activeNetworks.delete(net);
        MCO.lsSet('mco-maint-networks', JSON.stringify([...activeNetworks]));
        rebuildSource();   // re-emit source so colocation reflects visible networks
        applyAllFilters();
        renderLegend();    // counts depend on visible networks
        writeUrl();
      });
      subnetFiltersEl.appendChild(chip);
    }
  }
  // Only the legend-category visibility filter is applied here. Sub-network
  // filtering happens at source-emit time (see rebuildSource), so hidden-network
  // features aren't even in the source — no layer filter needed.
  function applyAllFilters() {
    if (!map || !map.getLayer('stations-layer')) return;
    const key         = currentCatKey();
    const catMatch    = ['in', ['get', key], ['literal', [...currentCats()]]];
    const anchorOnly  = ['==', ['get', 'colocationIndex'], 0];

    map.setFilter('stations-layer',  ['all', anchorOnly, catMatch]);
    map.setFilter('stations-badge',  ['all', anchorOnly, ['>', ['get', 'colocationCount'], 1], catMatch]);
    if (map.getLayer('stations-id-label')) {
      map.setFilter('stations-id-label', ['all', anchorOnly, catMatch]);
    }
    map.setFilter('spider-layer', catMatch);
    if (map.getLayer('spider-id-label')) {
      map.setFilter('spider-id-label', catMatch);
    }
    updateEmptyState();
  }

  // Show a small callout when current filter state hides everything, so the
  // user knows the empty map is intentional and how to recover.
  const emptyStateEl = document.getElementById('empty-state');
  function updateEmptyState() {
    if (!emptyStateEl || stations.length === 0) {
      if (emptyStateEl) emptyStateEl.hidden = true;
      return;
    }
    // [lead (bold), rest] — static strings, set as text.
    let msg = null;
    if (activeNetworks.size === 0) {
      msg = ['No networks selected.', ' Click HydroMet or AgriMet to show stations.'];
    } else if (currentCats().size === 0) {
      msg = ['All legend categories hidden.', ' Click a legend row to show stations.'];
    } else if (bucketMembers.size === 0) {
      msg = ['', 'No stations match the current filters.'];
    }
    if (msg) {
      const p = document.createElement('p');
      p.style.margin = '0';
      if (msg[0]) { const b = document.createElement('strong'); b.textContent = msg[0]; p.appendChild(b); }
      p.append(msg[1]);
      emptyStateEl.replaceChildren(p);
      emptyStateEl.hidden = false;
    } else {
      emptyStateEl.hidden = true;
    }
  }

  // ── Search (kit combobox + flyTo + popup) ────────────────────────────────
  // MCO.initSearchBox (kit 0.8.0) is the APG combobox this file used to
  // hand-roll: role/aria wiring, ranking, arrow/Home/End/Enter/Esc, the
  // "no matches" row as a disabled option, and a debounced count announcement.
  const searchBox = MCO.initSearchBox({
    input: searchInput,
    listbox: searchList,
    items: () => stations
      .filter((s) => stationById.has(s.station))
      .map((s) => ({ id: s.station, label: s.name || s.station, meta: `${s.station} · ${s.sub_network || '—'}` })),
    value: () => _selectedStation,
    label: 'Stations',
    limit: 8,
    onSelect: (id) => {
      // Rail drawer or compact overlay: dismiss it; the popup takes over.
      if (rail.isOpen()) rail.close({ restoreFocus: false });
      else if (searchCtl.isOpen()) searchCtl.close({ restoreFocus: false });
      else searchInput.blur();
      flyToAndOpen(id);
    },
  });

  // Below 640px the field collapses into a disclosure button grouped with the
  // other nav buttons and reopens as a full-width overlay bar under the navbar.
  // The kit owns the collapse mechanics only — the combobox above stays ours.
  const searchCtl = MCO.initSearchCollapse({
    wrap:    document.getElementById('search-wrap'),
    toggle:  document.getElementById('btn-search-toggle'),
    input:   searchInput,
    onClose: () => searchBox.close(),
  });
  // The kit's combobox consumes Esc while it has something to close (the
  // list, then the text). Once it passes Esc through, the compact overlay
  // closes and hands focus back to its toggle.
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented && searchCtl.isOpen()) {
      e.preventDefault();
      e.stopPropagation();
      searchCtl.close();
    }
  });

  // ── Landscape-phone rail (kit 0.10.0) ────────────────────────────────────
  // MCO.initNavRail owns the drawer: focus in, the page inert, Esc / scrim /
  // toggle to close, focus back to the toggle. The rail's search button is a
  // hot control: it opens the drawer on the search field.
  const rail = MCO.initNavRail({
    toggle: document.getElementById('btn-rail-menu'),
    drawer: document.getElementById('nav-drawer'),
    scrim: document.getElementById('rail-scrim'),
  });
  document.getElementById('btn-rail-search').addEventListener('click', () => rail.open(searchInput));

  // With ?kbd=off the '/' shortcut is disabled, so advertising it would be a
  // lie. (The kit already hides this hint inside the compact overlay bar.)
  if (!kbdShortcuts) {
    const kbdHint = document.querySelector('#search-wrap .search-kbd');
    if (kbdHint) kbdHint.hidden = true;
  }

  function flyToAndOpen(stationId) {
    const s = stationById.get(stationId);
    if (!s) { MCO.showToast('Station not found'); return; }
    if (s.sub_network && !activeNetworks.has(s.sub_network)) {
      // Re-enable its sub-network so the user can see the dot
      activeNetworks.add(s.sub_network);
      MCO.lsSet('mco-maint-networks', JSON.stringify([...activeNetworks]));
      for (const chip of subnetFiltersEl.querySelectorAll('.mco-chip')) {
        if (chip.dataset.network === s.sub_network) chip.setAttribute('aria-pressed', 'true');
      }
      rebuildSource();
      applyAllFilters();
      renderLegend();
    }
    closeSpider();
    map.flyTo({
      center: [s.longitude, s.latitude],
      zoom: SEARCH_FLY_ZOOM, speed: SEARCH_FLY_SPEED, animate: !MCO.reducedMotion(),
    });
    map.once('moveend', () => openPopupFor(stationId));
  }

  // ── Popup ────────────────────────────────────────────────────────────────
  // ── Photo lightbox (visit photos) ───────────────────────────────────────
  // Photo URLs come from the API response (AirTable attachments), so they are
  // untrusted. https only — anything else (javascript:, data:, a relative
  // path, garbage) is dropped — and the characters that could end the CSS
  // string or the url() token are percent-encoded, which is the same URL to
  // the server. They reach the DOM only through style properties and .src,
  // never markup (the popup used to interpolate p.thumb into style="").
  function safePhotoUrl(u) {
    // MCO.map.safeUrl (kit 0.8.0+): parsed, https: only, else null. Relative
    // values resolve against this page, so require an absolute URL first.
    const href = /^https:\/\//i.test(String(u)) ? MCO.map.safeUrl(u) : null;
    if (!href) return null;
    return href.replace(/['"()\\\s]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
  }
  // Tiny DOM builder for the popup: text only ever goes in as textContent.
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function photosEl(arr) {
    if (!Array.isArray(arr)) return null;
    const photos = arr
      .map((p) => p && { thumb: safePhotoUrl(p.thumb), full: safePhotoUrl(p.full), filename: p.filename })
      .filter((p) => p && p.thumb && p.full);
    if (!photos.length) return null;
    const wrap = el('div', 'visit-photos');
    photos.forEach((p, i) => {
      const b = el('button', 'visit-photo-thumb');
      b.type = 'button';
      b.style.backgroundImage = `url("${p.thumb}")`;
      b.setAttribute('aria-label', `View photo ${i + 1} of ${photos.length}`);
      if (p.filename) b.title = String(p.filename);
      b.addEventListener('click', () => openLightbox(photos, i));
      wrap.appendChild(b);
    });
    return wrap;
  }
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightbox-img');
  const lightboxCaption = document.getElementById('lightbox-caption');
  let _lb = { photos: [], index: 0 };
  function renderLightbox() {
    const p = _lb.photos[_lb.index];
    if (!p) return;
    lightboxImg.src = p.full;
    lightboxImg.hidden = false;
    lightboxImg.alt = p.filename || 'Visit photo';
    const multi = _lb.photos.length > 1;
    lightboxCaption.textContent = (p.filename || '') + (multi ? `   ${_lb.index + 1} / ${_lb.photos.length}` : '');
    document.getElementById('lightbox-prev').style.display = multi ? '' : 'none';
    document.getElementById('lightbox-next').style.display = multi ? '' : 'none';
  }
  function openLightbox(photos, index) {
    _lb = { photos: photos || [], index: index || 0 };
    renderLightbox();
    if (!lightbox.open) lightbox.showModal();
  }
  function stepLightbox(d) {
    if (_lb.photos.length < 2) return;
    _lb.index = (_lb.index + d + _lb.photos.length) % _lb.photos.length;
    renderLightbox();
  }
  // Reset to the 1x1 transparent placeholder rather than '': an empty src makes
  // the browser re-request the current page as an image.
  const BLANK_PX = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  function closeLightbox() {
    if (lightbox.open) lightbox.close();
    lightboxImg.src = BLANK_PX;
    lightboxImg.hidden = true;
  }
  document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
  document.getElementById('lightbox-prev').addEventListener('click', () => stepLightbox(-1));
  document.getElementById('lightbox-next').addEventListener('click', () => stepLightbox(1));
  lightbox.addEventListener('click', (e) => { if (e.target === lightbox) closeLightbox(); });
  lightbox.addEventListener('cancel', (e) => { e.preventDefault(); closeLightbox(); });
  document.addEventListener('keydown', (e) => {
    if (!lightbox.open) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); stepLightbox(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); stepLightbox(1); }
  });
  const STATE_PILL = {
    visited:   { cls: 'visited',   lbl: 'Visited this year' },
    overdue:   { cls: 'overdue',   lbl: 'Overdue' },
    new:       { cls: 'new',       lbl: 'New this year — exempt' },
    as_needed: { cls: 'as_needed', lbl: 'AgriMet — as-needed' },
    nodata:    { cls: 'nodata',    lbl: 'No data' },
  };
  // Trip-type chip colors are pulled from the trip-type legend so they always match.
  const TRIP_COLORS = Object.fromEntries(MODES.triptype.cats.map(c => [c.key, c.color]));
  function tripChips(arr) {
    const frag = document.createDocumentFragment();
    for (const t of (Array.isArray(arr) ? arr : [])) {
      const c = TRIP_COLORS[t] || TRIP_COLORS['Other'];
      // The category color marks the border and a light tint; the TEXT stays
      // --text-primary (CSS). Colored text failed 1.4.3 — Maintenance teal on
      // the dark popup surface measured under 4.5:1. c is one of MODES' hexes.
      const chip = el('span', 'trip-chip', t);
      chip.style.borderColor = c;
      chip.style.background = c + '22';
      frag.append(chip, ' ');
    }
    return frag;
  }
  function visitEl(v) {
    const item = el('div', 'visit-item');
    const head = el('div', 'visit-head');
    head.appendChild(el('span', 'visit-date', fmtDate(v.date)));
    if (v.date) head.appendChild(el('span', 'visit-rel', `· ${relDays(v.date)}`));
    head.appendChild(tripChips(v.trip_type));
    item.appendChild(head);
    if (v.inspected_by) {
      const who = el('div', 'visit-who');
      who.append(el('span', 'lbl', 'By'), ' ' + v.inspected_by);
      item.appendChild(who);
    }
    if (v.comments || v.description) item.appendChild(el('div', 'visit-note', v.comments || v.description));
    const sensors = [];
    if (v.sensors_added && v.sensors_added.length) sensors.push('+ ' + v.sensors_added.join(', '));
    if (v.sensors_removed && v.sensors_removed.length) sensors.push('− ' + v.sensors_removed.join(', '));
    if (sensors.length) item.appendChild(el('div', 'visit-sensors', sensors.join(' · ')));
    if (v.tasks && v.tasks.length) {
      const d = el('details', 'visit-tasks');
      d.appendChild(el('summary', null, `${v.tasks.length} task${v.tasks.length === 1 ? '' : 's'} completed`));
      const ul = el('ul');
      for (const t of v.tasks) ul.appendChild(el('li', null, t));
      d.appendChild(ul);
      item.appendChild(d);
    }
    const ph = photosEl(v.photos);
    if (ph) item.appendChild(ph);
    return item;
  }
  // Label/value pairs as the kit's .mco-facts <dl> (0.9.0), the same markup
  // MCO.map.popupContent emits, so the popup and the sheet read alike.
  function factsEl(pairs) {
    const dl = el('dl', 'mco-facts');
    for (const [k, v] of pairs) {
      const row = el('div');
      row.append(el('dt', null, k), el('dd', null, v));
      dl.appendChild(row);
    }
    return dl;
  }
  const withRel = (iso) => `${fmtDate(iso)} (${relDays(iso)})`;
  function stationBodyEl(stationId) {
    const s = stationById.get(stationId);
    const m = maintBySta.get(stationId) || null;
    const state = complianceStateFor(s);
    const pill = STATE_PILL[state] || STATE_PILL.overdue;
    const body = document.createDocumentFragment();

    // [data-peek]: what the bottom sheet's peek detent shows (pill + facts).
    const peek = el('div');
    peek.dataset.peek = '';
    body.appendChild(peek);
    const pillRow = el('div');
    pillRow.appendChild(el('span', `pop-pill ${pill.cls}`, pill.lbl));
    peek.appendChild(pillRow);

    // Facts where there are values; a prose note where the state needs one.
    const facts = [];
    let note = null;
    if (dataUnavailable) {
      note = 'Maintenance data is currently unavailable.';
    } else if (state === 'new') {
      note = 'Installed this year — not yet due for its annual Maintenance visit.';
    } else if (state === 'as_needed') {
      if (m && m.last_qualifying_visit_date) facts.push(['Last Maintenance', withRel(m.last_qualifying_visit_date)]);
      else if (m && m.last_visit_date) facts.push(['Last visit (any type)', withRel(m.last_visit_date)]);
      note = 'AgriMet station — visited as needed, not subject to the annual Maintenance requirement.';
    } else if (m && m.last_qualifying_visit_date) {
      const n = m.qualifying_visits_this_year;
      facts.push(['Last Maintenance', withRel(m.last_qualifying_visit_date)]);
      facts.push(['This year', `${n} Maintenance visit${n === 1 ? '' : 's'}`]);
    } else {
      note = 'No Maintenance visit on record.';
      if (m && m.last_visit_date) facts.push(['Last visit (any type)', fmtDate(m.last_visit_date)]);
    }
    if (facts.length) peek.appendChild(factsEl(facts));
    if (note) peek.appendChild(el('p', 'pop-summary', note));

    if (m && m.visits && m.visits.length) {
      body.appendChild(el('div', 'pop-section-title', 'Visits'));
      const scroll = el('div', 'pop-scroll');
      for (const v of m.visits) scroll.appendChild(visitEl(v));
      body.appendChild(scroll);
    }
    if (!m && !dataUnavailable) body.appendChild(el('div', 'pop-empty', 'No maintenance records for this station.'));
    return body;
  }
  // The station detail as DOM: the kit's popup shell (title, mono subtitle,
  // dashboard action through safeUrl) with this map's visit history inside.
  // No API string ever reaches setHTML/innerHTML (HOUSE-STYLE §7).
  // withTitle false: the sheet carries the name in its own <h2>.
  function stationContent(stationId, withTitle = true) {
    const s = stationById.get(stationId);
    const frag = MCO.map.popupContent({
      title: withTitle ? (s.name || stationId) : null,
      subtitle: `${stationId}${s.sub_network ? ` · ${s.sub_network}` : ''}`,
      actions: [{ label: 'Open dashboard →', href: DASH_URL(stationId) }],
    });
    const root = frag.querySelector('.mco-popup');
    root.insertBefore(stationBodyEl(stationId), root.querySelector('.mco-popup-actions'));
    return frag;
  }

  // ── Compact: the bottom sheet instead of the anchored popup ──────────────
  // On a phone an anchored 340px popup covers most of the map and the visit
  // history scrolls inside it. MCO.initSheet (kit 0.9.0) gives peek (pill +
  // summary) and full detents, drag and its keyboard twin, focus to the
  // title and back to the opener, and modality only in the full detent. The
  // two dialogs stay live: a thumb in the sheet opens the lightbox.
  const sheetEl = document.getElementById('station-sheet');
  const sheetTitleEl = document.getElementById('station-sheet-title');
  const sheetBodyEl = sheetEl.querySelector('.mco-sheet-body');
  let _sheetOpen = false;
  let _suppressSheetClose = false;
  const stationSheet = MCO.initSheet({
    sheet: sheetEl,
    peekHeight: 'auto',
    // A function (kit 0.11.3): resolved each time the full detent goes
    // modal, so whatever sits beside the sheet then is covered. The two
    // dialogs stay live: a thumb in the sheet opens the lightbox over it.
    inertRoots: () => MCO.overlay.siblingsOf(sheetEl, [infoModal, document.getElementById('lightbox')]),
    fallbackFocus: document.getElementById('map'),
    onState: (st) => {
      if (st !== 'closed') { _sheetOpen = true; return; }
      _sheetOpen = false;
      if (_suppressSheetClose) { _suppressSheetClose = false; return; }
      if (_selectedStation) deselected();
    },
  });
  function openSheetFor(stationId) {
    const s = stationById.get(stationId);
    sheetTitleEl.textContent = s.name || stationId;
    sheetBodyEl.replaceChildren(stationContent(stationId, false));
    stationSheet.open('peek');
  }

  function openPopupFor(stationId, lngLat) {
    const s = stationById.get(stationId);
    if (!s) return;
    if (_popup) { _suppressNextPopupClose = true; _popup.remove(); _popup = null; }
    // Drill-down gets ONE history entry: push on the first step from "no
    // station open", replace while one stays open (HOUSE-STYLE §4).
    const push = !_selectedStation && !_fromHistory;
    _selectedStation = stationId;
    if (MCO.viewport.isCompact()) {
      openSheetFor(stationId);
      announcePopup(stationId);
      writeUrl({ push });
      return;
    }
    if (_sheetOpen) { _suppressSheetClose = true; stationSheet.close({ restoreFocus: false }); }
    const p = new maplibregl.Popup({ closeOnClick: false, maxWidth: '340px', offset: 12 })
      .setLngLat(lngLat || [s.longitude, s.latitude])
      .setDOMContent(stationContent(stationId))
      .addTo(map);
    p.on('close', () => {
      if (_suppressNextPopupClose) { _suppressNextPopupClose = false; return; }
      if (_popup === p) {
        _popup = null;
        deselected();
      }
    });
    _popup = p;
    announcePopup(stationId);
    writeUrl({ push });
  }

  // ── Spider expand ────────────────────────────────────────────────────────
  // Argument is the bucket *key* (a string), not the bucketKey() function;
  // named differently to avoid shadowing the outer helper.
  function openSpider(key, anchorLngLat) {
    _spiderBucket = key;
    rebuildSpider(anchorLngLat);
  }
  function closeSpider() {
    if (_spiderBucket == null || !map) return;
    _spiderBucket = null;
    map.getSource('spider')?.setData(emptyFC());
    map.getSource('spider-lines')?.setData(emptyFC());
  }
  function rebuildSpider(anchorLngLatHint) {
    if (_spiderBucket == null || !map.getSource('spider')) return;
    // Members come from the dynamic bucketMembers map, which already excludes
    // hidden-network stations.
    const members = bucketMembers.get(_spiderBucket) || [];
    if (members.length <= 1) { closeSpider(); return; }

    const anchorId = bucketAnchor.get(_spiderBucket);
    const anchorMeta = stationById.get(anchorId);
    const anchorLngLat = anchorLngLatHint || [anchorMeta.longitude, anchorMeta.latitude];
    const anchorPx = map.project(anchorLngLat);
    const others = members.filter(s => s.station !== anchorId).map(s => s.station);
    const radius = SPIDER_RADIUS_PX;
    const stroke = dotStrokeColor();

    const feet = [];
    const lines = [];
    others.forEach((sid, i) => {
      const theta = (i / others.length) * 2 * Math.PI - Math.PI / 2;  // start at top
      const px = { x: anchorPx.x + radius * Math.cos(theta), y: anchorPx.y + radius * Math.sin(theta) };
      const ll = map.unproject(px);
      const s = stationById.get(sid);
      const cats = featurePropsFor(s);
      feet.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [ll.lng, ll.lat] },
        properties: {
          station: sid,
          name: s.name,
          sub_network: s.sub_network,
          complianceState: cats.complianceState,
          timeBinKey:  cats.timeBinKey,
          tripTypeKey: cats.tripTypeKey,
          colocationCount: 1,
          colocationIndex: 0,
          bucket: _spiderBucket,
        },
      });
      lines.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [anchorLngLat, [ll.lng, ll.lat]] },
        properties: { _strokeColor: stroke },
      });
    });
    map.getSource('spider').setData({ type: 'FeatureCollection', features: feet });
    map.getSource('spider-lines').setData({ type: 'FeatureCollection', features: lines });
  }

  // ── Map event wiring ─────────────────────────────────────────────────────
  // Keeps Montana filling the viewport: snaps back when the user zooms out past
  // the fitted extent, and recomputes that floor after a resize settles (the
  // zoom that fits MT is viewport-dependent).
  let _spiderMoveRaf = 0;
  function wireMapLoad() {
    zoomFloor = MCO.map.installZoomFloor(map);

    // EVERY style.load, not once: the first style, each theme switch, and the
    // blank fallback watchBasemap swaps in when CARTO fails all wipe our
    // sources and layers. addCustomLayers is idempotent; rebuildSource
    // refills the stations source from memory (a no-op before data lands).
    map.on('style.load', () => {
      addCustomLayers();
      rebuildSource();
    });
    // A basemap style that fails (or never answers) retries once, then falls
    // back to a blank --bg-deep style with a notice, so the stations still
    // draw instead of a white page.
    MCO.map.watchBasemap(map);

    map.on('load', () => {
      zoomFloor.refresh();
      _mapReady = true;
      // Kick off data fetch once layers exist, so rebuildSource never lands before its source.
      loadAll();
    });

    // Reflect every pan/zoom in the URL so the view is sharable
    map.on('moveend', writeUrl);

    // Keep spider feet anchored at constant pixel offset while the camera moves.
    // Coalesce multiple per-frame `move` events into a single rebuild via rAF.
    map.on('move', () => {
      if (!_spiderBucket || _spiderMoveRaf) return;
      _spiderMoveRaf = requestAnimationFrame(() => { _spiderMoveRaf = 0; rebuildSpider(); });
    });
  }

  // ── URL state ────────────────────────────────────────────────────────────
  // Lists are space-joined; URLSearchParams encodes spaces as '+', giving
  // tidy URLs like net=hydromet+agrimet. Enum-string values are lowercase.
  // Every parameter has a default and none is written while it matches, so a
  // fresh load carries no query string at all (HOUSE-STYLE §4).
  // Mirror the view into the query string (history.replaceState via the kit).
  // Was named pushState(), which it never did: it replaces. (MIGRATING 0.8.0)
  function writeUrl(opts) {
    const params = {};
    if (activeMode !== 'compliance') params.mode = activeMode;
    // Default is every known sub-network, so only a narrowed selection is
    // worth putting in the URL.
    if (activeNetworks.size !== KNOWN_NETWORKS.length) {
      params.net = [...activeNetworks].map(n => n.toLowerCase()).join(' ');
    }
    // Per-mode category sets: only serialize when not the full set.
    for (const mode of MODE_NAMES) {
      const set = visibleCatsByMode[mode];
      if (set.size !== allCatKeys(mode).length) {
        params[catParamKey(mode)] = [...set].join(' ');
      }
    }
    if (labelsOn) params.labels = 'on';
    if (legendCollapsed) params.legend = 'collapsed';
    if (!kbdShortcuts) params.kbd = 'off';
    // The theme's default is the OS preference, so emit it only when the user
    // has gone against that. Their own choice is remembered in localStorage
    // either way — the parameter exists so a shared link can carry a
    // deliberate one, not so every link imposes the sender's theme.
    const theme = MCO.getTheme();
    if (theme && theme !== MCO.osTheme()) params.theme = theme;
    // The camera's default is the fitted Montana extent. Emitted as a set,
    // because the parser needs all three to position the map.
    // cameraParamsIfDefault (kit 0.8.0) is {} while the camera sits where a
    // fresh load fits Montana, so a default view writes no lng/lat/zoom.
    if (_mapReady) Object.assign(params, MCO.map.cameraParamsIfDefault(map));
    if (_selectedStation) params.station = _selectedStation;
    if (opts && opts.push) MCO.pushUrlState(params, { state: { mcoDetail: _selectedStation } });
    else MCO.replaceUrlState(params);
  }

  // Track whether the next Popup `close` event was triggered programmatically
  // (so we don't writeUrl for an open-replace; the new popup pushes its own state).
  let _suppressNextPopupClose = false;
  // The station closed. If its entry was one we pushed, step Back over it
  // rather than leave a dead "station open" entry in the history; popstate
  // then re-syncs the URL to the current view. Otherwise just replace.
  let _fromHistory = false;
  function deselected() {
    _selectedStation = null;
    if (!_fromHistory && history.state && history.state.mcoDetail) history.back();
    else writeUrl();
  }
  // Back/Forward (MCO.onUrlState): open or close the station to match.
  MCO.onUrlState((params) => {
    const id = (params.get('station') || '').toLowerCase() || null;
    _fromHistory = true;
    try {
      if (id && id !== _selectedStation && stationById.has(id)) {
        closeSpider();
        openPopupFor(id);
      } else if (!id && _selectedStation) {
        closePopup();
      }
    } finally { _fromHistory = false; }
    writeUrl();   // sync the camera etc. into the restored entry
  });

  function closePopup() {
    if (_sheetOpen) { stationSheet.close(); return; }   // onState clears the selection
    if (!_popup) return;
    _suppressNextPopupClose = true;
    _popup.remove();
    _popup = null;
    if (_selectedStation) deselected();
  }

  // ── Spider close grace period (so cursor can travel from anchor to a foot) ─
  let _spiderCloseTimer = null;
  function scheduleSpiderClose() {
    if (_spiderCloseTimer) clearTimeout(_spiderCloseTimer);
    _spiderCloseTimer = setTimeout(() => { _spiderCloseTimer = null; closeSpider(); }, SPIDER_CLOSE_GRACE_MS);
  }
  function cancelSpiderClose() {
    if (_spiderCloseTimer) { clearTimeout(_spiderCloseTimer); _spiderCloseTimer = null; }
  }

  // ── Click handling ───────────────────────────────────────────────────────
  // Single dispatcher so badge + dot at the same point can't double-fire.
  // For stacked anchors: clicking opens (or toggles) the spider only — popups are
  // only opened by a second click on one of the spider feet.
  function wireMapClick() {
    map.on('click', (e) => {
      const feats = map.queryRenderedFeatures(e.point, {
        layers: ['spider-layer', 'stations-layer', 'stations-badge'],
      });
      if (feats.length === 0) {
        closeSpider();
        closePopup();
        return;
      }
      const f =
        feats.find(x => x.layer.id === 'spider-layer') ||
        feats.find(x => x.layer.id === 'stations-layer') ||
        feats[0];
      const props  = f.properties;
      const lngLat = f.geometry.coordinates.slice();
      if (f.layer.id === 'spider-layer') {
        // Second click — open the popup for the chosen station
        openPopupFor(props.station, lngLat);
        return;
      }
      // Click on the anchor (or its badge) of a stacked site → ensure the spider
      // is open AND open the anchor station's popup. (Hover already opens the spider
      // on desktop; on mobile this click is the first user gesture.) Dismissal is
      // via clicking elsewhere or pressing Esc — same as any popup.
      if (props.colocationCount > 1) {
        cancelSpiderClose();
        if (_spiderBucket !== props.bucket) openSpider(props.bucket, lngLat);
        openPopupFor(props.station, lngLat);
        return;
      }
      // Plain (non-co-located) station — close any open spider, open popup directly
      if (_spiderBucket) closeSpider();
      openPopupFor(props.station, lngLat);
    });
  }

  // ── Hover tooltip + hover-open spider for co-located sites ────────────────
  // The tooltip is MCO.map.initCursorTooltip (kit 0.8.0): the dispatcher,
  // edge-flipped positioning, cursor: pointer and mouseout cleanup, all set
  // with textContent. Spider hover stays ours, in its own listener below.
  const HOVER_LAYERS = [
    'spider-layer', 'spider-id-label',
    'stations-layer', 'stations-badge', 'stations-id-label',
  ];
  const ANCHOR_LAYER_IDS = new Set(['stations-layer', 'stations-badge', 'stations-id-label']);
  let _hoveredStation = null;

  function tooltipFor(f) {
    const stationId = f.properties.station;
    const s = stationById.get(stationId);
    if (!s) return null;
    const m = maintBySta.get(stationId) || null;
    const pill = STATE_PILL[complianceStateFor(s)] || STATE_PILL.overdue;
    const line = [pill.lbl];
    if (!dataUnavailable && m && m.last_qualifying_visit_date) {
      line.push(`last Maint./Repair ${relDays(m.last_qualifying_visit_date)}`);
    }
    return { name: s.name || stationId, sub: s.station, line };
  }

  function wireMapHover() {
    MCO.map.initCursorTooltip(map, {
      element: document.getElementById('tooltip'),
      layers: HOVER_LAYERS,
      render: tooltipFor,
    });
    // Hover-open the spider on a stacked anchor; close it (after a grace
    // period, so the cursor can travel to a foot) when the pointer leaves.
    map.on('mousemove', (e) => {
      const layers = HOVER_LAYERS.filter(lid => map.getLayer(lid));
      const f = (layers.length ? map.queryRenderedFeatures(e.point, { layers }) : [])[0] || null;
      if (f) {
        cancelSpiderClose();
        _hoveredStation = f.properties.station;
        if (ANCHOR_LAYER_IDS.has(f.layer.id)
            && f.properties.colocationCount > 1
            && _spiderBucket !== f.properties.bucket) {
          openSpider(f.properties.bucket, f.geometry.coordinates.slice());
        }
      } else if (_hoveredStation !== null) {
        scheduleSpiderClose();
        _hoveredStation = null;
      }
    });
    map.getCanvas().addEventListener('mouseleave', () => {
      scheduleSpiderClose();
      _hoveredStation = null;
    });
  }

  // Global keyboard shortcuts: ESC closes things; / focuses search.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // An open dialog (lightbox, info) owns this Esc; the sheet's own Esc is
      // handled by the kit's overlay stack.
      if (document.querySelector('dialog[open]') || e.defaultPrevented) return;
      closeSpider();
      closePopup();
      return;
    }
    if (kbdShortcuts && e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const t = e.target;
      const inField =
        t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (inField) return;
      e.preventDefault();
      // In rail mode the field lives in the closed drawer, and when it is
      // collapsed the overlay has to open first: otherwise '/' focuses an
      // input that is display:none and the keystroke is lost.
      if (rail.isRail()) { rail.open(searchInput); return; }
      if (searchCtl.isCollapsed()) { searchCtl.open(); return; }
      searchInput.focus();
      searchInput.select();
    }
  });
  // ── Mode toggle ──────────────────────────────────────────────────────────
  // Segmented buttons above 1060px, a <select> at and below it
  // (MCO.initSegmentedFallback, kit 0.9.0): one value, each mirrors the
  // other, and focus follows across a breakpoint flip.
  function setMode(mode) {
    if (!MODES[mode] || mode === activeMode) return;
    activeMode = mode;
    MCO.lsSet('mco-maint-mode', activeMode);
    refreshDotColors();
    applyAllFilters();  // category filter belongs to the active mode
    writeUrl();
  }
  const modeCtl = MCO.initSegmentedFallback({
    group: document.getElementById('mode-seg'),
    select: document.getElementById('mode-select'),
    onChange: setMode,
  });
  modeCtl.set(activeMode);

  // ── Refresh (manual data reload) ─────────────────────────────────────────
  // (A manual refresh doesn't refly to the deep-linked station: loadAll
  // consumes ?station= only on the first load.)
  function refreshData() {
    if (!_mapReady) return;   // the map's load handler runs the first fetch
    refreshStampEl.textContent = 'loading…';
    loadAll();
  }
  document.getElementById('btn-refresh').addEventListener('click', refreshData);

  // ── Labels toggle ────────────────────────────────────────────────────────
  let labelsOn = (() => {
    const u = getLower('labels');
    if (u === 'on' || u === 'off') return u === 'on';
    return MCO.lsGet('mco-maint-labels') === 'on';
  })();
  const labelsBtn = document.getElementById('btn-labels');
  labelsBtn.setAttribute('aria-pressed', labelsOn ? 'true' : 'false');
  function applyLabelsVisibility() {
    if (!map) return;
    const vis = labelsOn ? 'visible' : 'none';
    for (const lid of ['stations-id-label', 'spider-id-label']) {
      if (map.getLayer(lid)) map.setLayoutProperty(lid, 'visibility', vis);
    }
  }
  labelsBtn.addEventListener('click', () => {
    labelsOn = !labelsOn;
    labelsBtn.setAttribute('aria-pressed', labelsOn ? 'true' : 'false');
    MCO.lsSet('mco-maint-labels', labelsOn ? 'on' : 'off');
    applyLabelsVisibility();
    writeUrl();
  });

  // ── Legend collapse/expand ───────────────────────────────────────────────
  // MCO.initCollapsible owns the animation, [hidden] (so collapsed rows leave
  // the tab order), aria-expanded, and persistence. The control stays a real
  // <button>, keyboard-accessible with Enter/Space out of the box.
  const legendToggleBtn = document.getElementById('legend-toggle-btn');
  let legendCollapsed = (() => {
    const u = getLower('legend');
    if (u === 'open' || u === 'collapsed') return u === 'collapsed';
    // The kit persists '1'/'0'; this page shipped 'collapsed'/'expanded'.
    // Read both, or every returning visitor silently reverts to expanded
    // (MIGRATING § gotchas).
    const saved = MCO.lsGet('mco-maint-legend');
    if (saved === 'collapsed' || saved === '1') return true;
    if (saved === 'expanded'  || saved === '0') return false;
    return MCO.viewport.isCompact();   // no preference: start collapsed on a phone
  })();

  // apply() runs once at init and calls onChange with it. Don't let that first
  // call reach writeUrl: it would rewrite the URL before the deep-link handler
  // has set _selectedStation, stripping ?station= off the link that opened it.
  let _legendInit = true;
  MCO.initCollapsible({
    toggle: legendToggleBtn,
    body: document.getElementById('legend-body'),
    storageKey: 'mco-maint-legend',
    startCollapsed: legendCollapsed,
    onChange: (collapsed) => {
      legendCollapsed = collapsed;
      legendToggleBtn.setAttribute('aria-label', collapsed ? 'Expand legend' : 'Collapse legend');
      if (!_legendInit) writeUrl();
    },
  });
  _legendInit = false;

  // ── Legend (Plotly-style toggles) ────────────────────────────────────────
  // MCO.initLegendToggles (kit 0.8.0) owns the interaction: click toggles a
  // category, double-click (or Shift+Enter) isolates it, aria-pressed drives
  // the styling, and each change is announced once. The kit dims the SWATCH
  // of an off row, never the row: the old `.legend-row.off { opacity: .4 }`
  // took the label to ~2.7:1 (WCAG 1.4.3).

  // Count stations per category of the active mode, respecting the visible
  // sub-network set (so the legend counts match what's on the map).
  function categoryCounts() {
    const counts = {};
    const key = currentCatKey();
    for (const s of stations) {
      if (!stationById.has(s.station)) continue;
      if (s.sub_network && !activeNetworks.has(s.sub_network)) continue;
      const v = featurePropsFor(s)[key];
      counts[v] = (counts[v] || 0) + 1;
    }
    return counts;
  }

  // Rows are rebuilt whenever counts or the mode change, so the toggles
  // controller is rebuilt with them.
  let _legendCtl = null;
  function renderLegend() {
    if (_legendCtl) { _legendCtl.dispose(); _legendCtl = null; }
    legendRowsEl.innerHTML = '';
    const m = MODES[activeMode];
    legendTitleEl.textContent = m.legendTitle;
    const counts = categoryCounts();
    const rows = [];
    for (const r of m.cats) {
      if (r.hidden) continue;   // e.g. compliance "No data" — only set on a total fetch failure
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'mco-legend-row';
      row.dataset.key = r.key;
      const sw = document.createElement('span');
      sw.className = 'mco-legend-swatch';
      sw.dataset.shape = 'circle';   // the map mark is a dot
      sw.style.setProperty('--swatch', r.color);
      sw.setAttribute('aria-hidden', 'true');
      const lb = document.createElement('span');
      lb.className = 'mco-legend-label';
      lb.textContent = r.label;
      const ct = document.createElement('span');
      ct.className = 'mco-legend-count';
      ct.textContent = String(counts[r.key] || 0);
      row.append(sw, lb, ct);
      legendRowsEl.appendChild(row);
      rows.push(row);
    }
    const hint = document.createElement('div');
    hint.className = 'legend-hint';
    hint.textContent = 'Click to toggle · Double-click to isolate';
    legendRowsEl.appendChild(hint);

    const rowKeys = new Set(rows.map((r) => r.dataset.key));
    _legendCtl = MCO.initLegendToggles({
      rows,
      visible: [...currentCats()].filter((k) => rowKeys.has(k)),
      noun: 'categories',
      onChange: (vis) => {
        // Categories with no legend row (compliance "nodata") keep their
        // state: the controller only knows the rows it was given.
        const set = currentCats();
        for (const k of rowKeys) { if (vis.has(k)) set.add(k); else set.delete(k); }
        applyAllFilters();
        writeUrl();
      },
    });
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  // The UI above is wired; the map waits for MapLibre 6 (an ES module the kit
  // imports). Its 'load' event then drives the data fetch — see wireMapLoad().
  renderLegend();
  MCO.map.loadMapLibre().then(initMap, (err) => {
    console.error(err);
    refreshStampEl.textContent = 'map unavailable';
    MCO.notice({ tone: 'danger', text: 'The map library failed to load. Check your connection and reload the page.' });
    MCO.ready();
  });

})();

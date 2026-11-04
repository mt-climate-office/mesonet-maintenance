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


  const SEARCH_FLY_ZOOM         = 11;     // zoom when search/deep-link flies to a station
  // Label collision detection switches on at this zoom
  const LABEL_MINZOOM           = 6;
  // Reservation name labels switch on at this zoom (less cluttered at MT extent)
  const TRIBAL_LABEL_MINZOOM    = 7;

  // Trip-type precedence (first match on last_trip_type wins) for triptype mode.
  const TRIP_PRECEDENCE = ['Maintenance', 'Repair', 'Ground Game', 'Structure Install', 'Tech Install'];

  // Mode configs. Each mode = a catKey (the GeoJSON property the legend/filter/
  // paint key on), a legend title, the kit category set its colors and labels
  // come from, and ordered category keys. `hollow` categories (no data) are
  // drawn unfilled and are not in the kit set.
  const MODES = {
    compliance: {
      catKey: 'complianceState',
      legendTitle: 'HydroMet requirement (this year)',
      set: 'maintenance-compliance',
      cats: [
        { key: 'visited' },
        { key: 'overdue' },
        { key: 'new' },
        // A compliance category (AgriMet carries no annual requirement), not
        // a network marker: HOUSE-STYLE §6, decision 5 of the 0.21.0 audit.
        { key: 'as_needed' },
        // 'nodata' only occurs on a total fetch failure (every station at once,
        // covered by the banner). Kept for paint/filter but hidden from the legend.
        { key: 'nodata', label: 'No data', hidden: true, hollow: true },
      ],
    },
    timesince: {
      catKey: 'timeBinKey',
      legendTitle: 'Since last Maintenance',
      // The kit's age ramp (lightness-monotonic, so it survives grayscale).
      set: 'maintenance-age',
      cats: [
        { key: '0' }, { key: '1' }, { key: '2' }, { key: '3' }, { key: '4' },
        { key: 'null', label: 'Never / no data', hollow: true },
      ],
    },
    triptype: {
      catKey: 'tripTypeKey',
      legendTitle: 'Most recent trip type',
      set: 'maintenance-trip',
      // Reverse of the natural work order (Ground Game → Structure → Tech →
      // Repair → Maintenance), so Maintenance sits on top; the kit set's order.
      cats: [
        { key: 'Maintenance' }, { key: 'Repair' }, { key: 'Tech Install' },
        { key: 'Structure Install' }, { key: 'Ground Game' }, { key: 'Other' },
      ],
    },
  };
  const MODE_NAMES = Object.keys(MODES);
  // Category colors and labels: the kit's map category sets (palette 0.21.0,
  // MCO.palette.categorySet), per theme. Every color clears 3:1 on both
  // basemaps, the surfaces and the tribal fill, stays clear of the
  // orange/brown band the tribal fill owns, and stays distinct under CVD
  // simulation (kit CI). Re-read on every theme change, before the restyle.
  function applyPalette() {
    const theme = MCO.getTheme();
    for (const m of Object.values(MODES)) {
      const rows = new Map(MCO.palette.categorySet(m.set, theme).map((r) => [r.key, r]));
      for (const c of m.cats) {
        if (c.hollow) continue;
        const r = rows.get(c.key);
        c.color = r.color;
        c.label = r.label;
      }
    }
  }
  applyPalette();

  // ── DOM refs ─────────────────────────────────────────────────────────────
  const refreshStampEl= document.getElementById('refresh-stamp');
  const subnetFiltersEl = document.getElementById('subnet-filters');
  const legendRowsEl  = document.getElementById('legend-rows');
  const legendTitleEl = document.getElementById('legend-title');
  const searchInput   = document.getElementById('search-input');
  const searchList    = document.getElementById('search-dropdown');
  const infoModal     = document.getElementById('info-modal');
  const mapContainerEl = document.getElementById('map-container');

  // Tell screen-reader users which station opened when the sheet is shown via
  // click, search, or deep-link. MCO.announce (kit 0.8.0) owns the polite
  // live region, its clear-then-set (so a repeat is re-read) and de-dupe.
  function announceStation(stationId) {
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
  // The category colors are per theme: re-read them before the restyle.
  document.addEventListener('mco:themechange', () => {
    applyPalette();
    if (map) map.setStyle(MCO.map.cartoStyleUrl());
    else renderLegend();
    if (_sheetOpen && _selectedStation) fillSheet(_selectedStation);
    writeUrl();
  });

  // ── Info modal ───────────────────────────────────────────────────────────
  // The kit owns backdrop-click, [data-close-modal] delegation, and
  // opener-captured focus restore.
  // First-visit intro (kit 0.21.0 `intro`): auto-opens once per browser,
  // marked seen as it opens, never over a deep link (a visitor sent to one
  // station came for that station) and never once focus has moved. Deferred
  // until the first data load, so the map is drawn behind it.
  // scripts/generate_preview.py seeds this key to keep the card clear.
  const btnInfo = document.getElementById('btn-info');
  const _bootParams = MCO.urlParams();
  const _isDeepLink = ['station', 'lng', 'lat', 'zoom']
    .some((k) => _bootParams.has(k));
  const infoModalCtl = MCO.initInfoModal({
    dialog: infoModal, trigger: btnInfo,
    intro: { key: 'mco-maint-seen-intro', skip: _isDeepLink, defer: true },
  });
  // The Data section's credit line is the kit's one wording.
  document.getElementById('info-credit').textContent = MCO.credit({ source: 'Montana Mesonet' });

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
  // The freshness stamp (kit 0.21.0): "Updated 2:45 PM MST", in Mountain
  // time whatever the viewer's zone, with the date when it isn't today in
  // Montana. The maintenance feed is a live AirTable read that carries no
  // data timestamp, so the time is when the load landed (HOUSE-STYLE §4).
  // scripts/generate_preview.py waits for this text ("^Updated").
  function refreshStamp(ms) {
    MCO.formatUpdatedMT(ms, { into: refreshStampEl });
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
  let dataUnavailable = false;                // true if the maintenance fetch failed/empty
  // Colocated stations (MCO.map.colocation, kit 0.21.0): one marker with a
  // count badge per site, fanned out as a spider on hover or tap. Created
  // with the map; it groups the visible-network stations on every
  // rebuildSource().
  let coloc = null;
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
  // The ?station= deep link is consumed by the FIRST data load only. Read in
  // loadAll(), so a manual Refresh never re-opens a station that was closed.
  let _initStationConsumed = false;

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
    MCO.map.addFitControl(map, { onBeforeFit: () => coloc.close() });
    // Colocation owns the station click (a foot, an anchor, a plain dot, or
    // the empty map), the hover fan-out with its 250 ms grace, and Esc.
    coloc = MCO.map.colocation(map, {
      source: 'stations',
      // HydroMet anchors a shared site; the AgriMet station fans out.
      rank: (s) => (s.sub_network === 'HydroMet' ? 0 : s.sub_network === 'AgriMet' ? 1 : 99),
      visible: (s) => !s.sub_network || activeNetworks.has(s.sub_network),
      properties: (s) => Object.assign({
        station: s.station, name: s.name, sub_network: s.sub_network,
      }, featurePropsFor(s)),
      anchorLayers: ['stations-hit', 'stations-layer', 'stations-badge', 'stations-badge-disc'],
      spiderLayers: ['spider-hit', 'spider-layer'],
      onSelect: (id) => openStation(id, { push: true, opener: map.getCanvas() }),
      onEmpty: () => closeStation(),
    });
    wireMapLoad();
    wireMapHover();
  }

  function addCustomLayers() {
    if (!map.getSource('stations')) {
      map.addSource('stations', { type: 'geojson', data: emptyFC() });
    }
    coloc.addSources();   // the spider's feet and connector lines
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

    // Stations: one uniform circle per site (no network encoding, kit
    // 0.21.0), the fill carrying the active mode's category. Anchors only;
    // a stacked anchor carries a count badge and fans out as the spider.
    const A = MCO.map.colocation.ANCHOR_ONLY;
    const NONE = ['==', ['get', 'station'], '__none__'];
    const stationLayers = [
      { id: 'spider-lines-layer', type: 'line', source: coloc.spiderLinesSource,
        paint: MCO.map.colocation.spiderLinePaint() },
      // Invisible tap targets (>= 22px across), filtered with the dots.
      { id: 'stations-hit', type: 'circle', source: 'stations', filter: A, paint: MCO.map.hitPaint() },
      { id: 'stations-layer', type: 'circle', source: 'stations', filter: A, paint: stationPaint() },
      // The open station's ring. Not anchor-only: a site member that isn't
      // the anchor sits at the same point, so the ring still marks the site.
      { id: 'stations-selected', type: 'circle', source: 'stations', filter: NONE, paint: MCO.map.selectionPaint() },
      ...MCO.map.colocation.badgeLayers({ id: 'stations-badge', source: 'stations' }),
      { id: 'stations-id-label', type: 'symbol', source: 'stations', minzoom: LABEL_MINZOOM,
        layout: stationLabelLayout(), paint: stationLabelPaint() },
      { id: 'spider-hit', type: 'circle', source: coloc.spiderSource, paint: MCO.map.hitPaint() },
      { id: 'spider-layer', type: 'circle', source: coloc.spiderSource, paint: stationPaint() },
      { id: 'spider-selected', type: 'circle', source: coloc.spiderSource, filter: NONE, paint: MCO.map.selectionPaint() },
      { id: 'spider-id-label', type: 'symbol', source: coloc.spiderSource,
        layout: stationLabelLayout(), paint: stationLabelPaint() },
    ];
    for (const l of stationLayers) if (!map.getLayer(l.id)) map.addLayer(l);

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
    paintSelection();
  }

  function emptyFC() { return { type: 'FeatureCollection', features: [] }; }

  // ── Paint expression generators ──────────────────────────────────────────
  // Simple match on the active mode's catKey → its category colors.
  function paintColorForMode(mode) {
    const m = MODES[mode];
    const expr = ['match', ['get', m.catKey]];
    for (const c of m.cats) if (!c.hollow) expr.push(c.key, c.color);
    expr.push('rgba(0,0,0,0)');   // unknown key: drawn hollow, like no data
    return expr;
  }

  // `hollow` categories (no data) are drawn unfilled: a 2px --dot-stroke
  // edge alone, the same edge contrast every dot has. The kit's category
  // sets leave "no data" out for this reason (palette 0.21.0): no neutral
  // fill stays clear of every bin. Same treatment as mesonet-status's
  // "No record".
  function hollowMatch(mode) {
    const m = MODES[mode];
    const keys = m.cats.filter(c => c.hollow).map(c => c.key);
    return keys.length ? ['in', ['get', m.catKey], ['literal', keys]] : null;
  }
  function dotColor(mode) {
    const hollow = hollowMatch(mode);
    return hollow ? ['case', hollow, 'rgba(0,0,0,0)', paintColorForMode(mode)] : paintColorForMode(mode);
  }
  function dotStrokeWidth(mode) {
    const hollow = hollowMatch(mode);
    return hollow ? ['case', hollow, 2, 1.2] : 1.2;
  }

  // The kit's one station circle (MCO.map.stationPaint, 0.21.0): its radius
  // ramp and --dot-stroke edge, with the fill carrying the category.
  function stationPaint() {
    return MCO.map.stationPaint({
      fill: dotColor(activeMode),
      stroke: dotStrokeColor(),
      strokeWidth: dotStrokeWidth(activeMode),
    });
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
    const color = dotColor(activeMode);
    const stroke = dotStrokeColor();
    const width = dotStrokeWidth(activeMode);
    for (const lid of ['stations-layer', 'spider-layer']) {
      map.setPaintProperty(lid, 'circle-color', color);
      map.setPaintProperty(lid, 'circle-stroke-color', stroke);
      map.setPaintProperty(lid, 'circle-stroke-width', width);
    }
    refreshLabelPaint();
    refreshTribalPaint();
    refreshStatePaint();
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
      refreshStamp(Date.now());
      // Deep-link from ?station=… in URL, on the FIRST load only: a manual
      // Refresh must not re-open a station the visitor has since closed.
      // loadAll() is only called from the map's 'load' handler (and
      // Refresh), so _mapReady is always true here.
      const firstLoad = !_initStationConsumed;
      _initStationConsumed = true;
      if (firstLoad && _initStation && stationById.has(_initStation)) {
        // A link that also names the camera keeps it (the station only has
        // to be in view); otherwise fly in to the station.
        goTo(_initStation, { push: false, keepZoom: _hasInitPos });
      } else {
        if (firstLoad && _initStation) {
          // Unknown station id: say so, and drop it from the URL.
          _selectedStation = null;
          MCO.showToast('Station not found');
        }
        // A station still open after a Refresh shows the new visit data.
        if (_sheetOpen && _selectedStation && stationById.has(_selectedStation)) fillSheet(_selectedStation);
        // Push initial URL so it's clean even if the user hasn't interacted yet
        writeUrl();
        if (firstLoad) infoModalCtl.intro();
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
      if (!_initStationConsumed) { _initStationConsumed = true; infoModalCtl.intro(); }
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
  // Static index: station metadata by id, for stations with a location.
  // Co-location (count, anchor, members) is MCO.map.colocation's, regrouped
  // in rebuildSource() over the currently-visible sub-networks, so disabling
  // a network resolves a 2-stack to a single un-badged dot.
  function indexStations() {
    stationById.clear();
    for (const s of stations) {
      const lat = Number(s.latitude), lon = Number(s.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      // Normalize to numbers so downstream geometry / project() is happy.
      s.latitude = lat; s.longitude = lon;
      stationById.set(s.station, s);
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
    if (!map || !map.getSource('stations') || !coloc) return;
    // MCO.map.colocation groups the visible-network stations (4-decimal
    // buckets), ranks each site's anchor (HydroMet first, so hiding HydroMet
    // promotes the AgriMet station, or leaves it a plain dot), writes the
    // source with colocationCount/colocationIndex/bucket on every feature,
    // and refreshes an open spider. Hidden-network stations are left out.
    const fc = coloc.setData([...stationById.values()]);
    rebuildSrTable(fc.features);
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
      { key: 'site', label: 'Site' },
    ],
    rowKey: (r) => r.station,
    // The keyboard and screen-reader path to every station, colocated or
    // not (the canvas spider is pointer-only): Enter opens its sheet.
    selectable: true,
    onSelect: (r) => goTo(r.station, { push: true }),
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
          site: p.colocationCount > 1 ? `${p.colocationCount} stations at this site` : null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    _srRows = rows;
    srTwin.render(rows, { selected: _selectedStation });
  }
  let _srRows = [];

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
    const anchorOnly  = MCO.map.colocation.ANCHOR_ONLY;
    const anchored    = ['all', anchorOnly, catMatch];
    const badge       = MCO.map.colocation.badgeFilter(catMatch);

    // The hit targets follow the dots, so a hidden category can't be clicked.
    for (const lid of ['stations-hit', 'stations-layer', 'stations-id-label']) {
      if (map.getLayer(lid)) map.setFilter(lid, anchored);
    }
    for (const lid of ['stations-badge', 'stations-badge-disc']) {
      if (map.getLayer(lid)) map.setFilter(lid, badge);
    }
    for (const lid of ['spider-hit', 'spider-layer', 'spider-id-label']) {
      if (map.getLayer(lid)) map.setFilter(lid, catMatch);
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
    } else if (!coloc || coloc.collection().features.length === 0) {
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

  // ── Search (kit combobox + fly + sheet) ──────────────────────────────────
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
      // Rail or compact drawer: dismiss it; the sheet takes over.
      if (rail.isOpen()) rail.close({ restoreFocus: false });
      else searchInput.blur();
      goTo(id, { push: true });
    },
  });

  // ── Phone bar: compact drawer + landscape rail (kit 0.21.0 / 0.10.0) ────
  // MCO.initNavRail owns the drawer in both modes: focus in, the page (and
  // the rest of the bar) inert, Esc / scrim / ☰ to close, focus back to the
  // button that opened it. The bar's search button opens the drawer on the
  // search field; in a compact bar the field never collapses to an overlay,
  // so there is no MCO.initSearchCollapse.
  const rail = MCO.initNavRail({
    toggle: document.getElementById('btn-rail-menu'),
    drawer: document.getElementById('nav-drawer'),
    scrim: document.getElementById('rail-scrim'),
    search: { toggle: document.getElementById('btn-rail-search'), input: searchInput },
  });

  // With ?kbd=off the '/' shortcut is disabled, so advertising it would be a
  // lie. (The kit already hides this hint inside the compact overlay bar.)
  if (!kbdShortcuts) {
    const kbdHint = document.querySelector('#search-wrap .search-kbd');
    if (kbdHint) kbdHint.hidden = true;
  }

  // Search pick, sr-table row and ?station= deep link: fly, then open the
  // sheet once the map is idle with the station in view
  // (MCO.map.flyToAndOpen, kit 0.21.0; the old first-'moveend' open could
  // fire before the camera arrived). A station whose network is hidden gets
  // its network turned back on first.
  function goTo(stationId, o = {}) {
    const s = stationById.get(stationId);
    if (!s) { MCO.showToast('Station not found'); return; }
    if (!map) return;
    coloc.close();
    MCO.map.flyToAndOpen(map, {
      center: [s.longitude, s.latitude],
      zoom: o.keepZoom ? map.getZoom() : SEARCH_FLY_ZOOM,
      ensureVisible: () => {
        if (!s.sub_network || activeNetworks.has(s.sub_network)) return;
        activeNetworks.add(s.sub_network);
        MCO.lsSet('mco-maint-networks', JSON.stringify([...activeNetworks]));
        for (const chip of subnetFiltersEl.querySelectorAll('.mco-chip')) {
          if (chip.dataset.network === s.sub_network) chip.setAttribute('aria-pressed', 'true');
        }
        rebuildSource();
        applyAllFilters();
        renderLegend();
      },
      open: () => openStation(stationId, o),
    });
  }

  // ── Station sheet content ────────────────────────────────────────────────
  // ── Photo lightbox (visit photos) ───────────────────────────────────────
  // Photo URLs come from the API response (AirTable attachments), so they are
  // untrusted. https only — anything else (javascript:, data:, a relative
  // path, garbage) is dropped — and the characters that could end the CSS
  // string or the url() token are percent-encoded, which is the same URL to
  // the server. They reach the DOM only through style properties and .src,
  // never markup (the old popup interpolated p.thumb into style="").
  function safePhotoUrl(u) {
    // MCO.map.safeUrl (kit 0.8.0+): parsed, https: only, else null. Relative
    // values resolve against this page, so require an absolute URL first.
    const href = /^https:\/\//i.test(String(u)) ? MCO.map.safeUrl(u) : null;
    if (!href) return null;
    return href.replace(/['"()\\\s]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
  }
  // Tiny DOM builder for the sheet: text only ever goes in as textContent.
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
  // Trip-type chip colors are pulled from the trip-type legend so they always
  // match, read at render time because the kit set is per theme.
  const catColor = (mode, key) => (MODES[mode].cats.find((c) => c.key === key) || {}).color;
  function tripChips(arr) {
    const frag = document.createDocumentFragment();
    for (const t of (Array.isArray(arr) ? arr : [])) {
      const c = catColor('triptype', t) || catColor('triptype', 'Other');
      // The category color marks the border and a light tint; the TEXT stays
      // --text-primary (CSS). Colored text failed 1.4.3 on the sheet surface.
      // c is a kit category-set hex (#rrggbb), so the alpha suffix is valid.
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
  // MCO.map.popupContent emits.
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
    // The state pill: a dot in the station's compliance color (the map's
    // mark in Compliance mode) and the state named in text.
    const pillRow = el('div');
    const pillEl = el('span', `pop-pill ${pill.cls}`);
    const dot = el('span', 'pop-pill-dot');
    dot.setAttribute('aria-hidden', 'true');
    const cat = MODES.compliance.cats.find((c) => c.key === state);
    if (!cat || cat.hollow) dot.classList.add('hollow');
    else dot.style.setProperty('--pill-color', cat.color);
    pillEl.append(dot, pill.lbl);
    pillRow.appendChild(pillEl);
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

    // The other stations at this site (MCO.map.colocation): the keyboard
    // and touch path across it, since the canvas spider is pointer-only.
    const sibs = coloc ? coloc.siblings(stationId) : [];
    if (sibs.length) {
      body.appendChild(el('div', 'pop-section-title', 'Also at this site'));
      const ul = el('ul', 'pop-siblings');
      for (const o of sibs) {
        const li = el('li');
        const b = el('button', 'nav-btn', `${o.name || o.station} (${o.sub_network || o.station})`);
        b.type = 'button';
        b.addEventListener('click', () => openStation(o.station, { push: false }));
        li.appendChild(b);
        ul.appendChild(li);
      }
      body.appendChild(ul);
    }
    return body;
  }
  // The station detail as DOM: the kit's detail shell (mono subtitle,
  // dashboard action through safeUrl) with this map's visit history inside.
  // No API string ever reaches setHTML/innerHTML (HOUSE-STYLE §7). The
  // sheet carries the name in its own <h2>, so the shell has no title.
  function stationContent(stationId) {
    const s = stationById.get(stationId);
    const frag = MCO.map.popupContent({
      title: null,
      subtitle: `${stationId}${s.sub_network ? ` · ${s.sub_network}` : ''}`,
      actions: [{ label: 'Open dashboard →', href: DASH_URL(stationId) }],
    });
    const root = frag.querySelector('.mco-popup');
    root.insertBefore(stationBodyEl(stationId), root.querySelector('.mco-popup-actions'));
    return frag;
  }

  // ── Station sheet (MCO.initSheet at every width, kit 0.21.0) ──────────────
  // End-docked above compact, a bottom sheet on a phone, never an anchored
  // popup. The kit gives peek (pill + summary) and full detents, drag and
  // its keyboard twin, focus to the title and back to the opener, and
  // modality only in the full detent on compact. The two dialogs stay live:
  // a thumb in the sheet opens the lightbox over it.
  // The end-docked sheet sits under the chrome at top: var(--chrome-h). The
  // kit publishes that only for an .is-sticky bar; this bar is in flow, so
  // publish its height here, or the navbar covers the sheet's title and
  // close button. (The landscape rail forces it back to 0 in the kit CSS.)
  MCO.metrics.observe('--chrome-h', document.getElementById('navbar'));
  const sheetEl = document.getElementById('station-sheet');
  const sheetTitleEl = document.getElementById('station-sheet-title');
  const sheetBodyEl = sheetEl.querySelector('.mco-sheet-body');
  let _sheetOpen = false;
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
      if (_selectedStation) deselected();
      paintSelection();
      srTwin.render(_srRows, { selected: null });
    },
  });
  function fillSheet(stationId) {
    const s = stationById.get(stationId);
    sheetTitleEl.textContent = s.name || stationId;
    sheetBodyEl.replaceChildren(stationContent(stationId));
  }

  // Open (or switch) the station sheet. Drill-down gets ONE history entry:
  // push on the first open from "no station open" when the caller asks
  // (a click, a search pick, a table row), replace for a deep link at boot
  // (its entry is the page's own, so closing must never step back off the
  // site) and while a station stays open (HOUSE-STYLE §4). Back/Forward
  // (fromHistory) already moved the URL.
  function openStation(stationId, o = {}) {
    if (!stationById.has(stationId)) return;
    const first = !_selectedStation || !_sheetOpen;
    _selectedStation = stationId;
    fillSheet(stationId);
    if (!_sheetOpen) stationSheet.open('peek', { opener: o.opener });
    else sheetTitleEl.focus({ preventScroll: true });   // the old content (and focus) is gone
    paintSelection();
    srTwin.render(_srRows, { selected: stationId });
    announceStation(stationId);
    if (o.fromHistory) return;
    writeUrl({ push: !!o.push && first && !(history.state && history.state.mcoDetail) });
  }
  function closeStation() {
    if (_sheetOpen) stationSheet.close();   // onState clears the selection
  }
  // The open station's ring, on its site and on its spider foot.
  function paintSelection() {
    if (!map) return;
    const f = ['==', ['get', 'station'], _selectedStation || '__none__'];
    for (const lid of ['stations-selected', 'spider-selected']) {
      if (map.getLayer(lid)) map.setFilter(lid, f);
    }
  }

  // ── Map event wiring ─────────────────────────────────────────────────────
  // Keeps Montana filling the viewport: snaps back when the user zooms out past
  // the fitted extent, and recomputes that floor after a resize settles (the
  // zoom that fits MT is viewport-dependent).
  function wireMapLoad() {
    zoomFloor = MCO.map.installZoomFloor(map);

    // EVERY style.load, not once: the first style, each theme switch, and the
    // blank fallback watchBasemap swaps in when CARTO fails all wipe our
    // sources and layers. addCustomLayers is idempotent (and re-adds the
    // spider sources); rebuildSource refills the stations source from memory
    // (a no-op before data lands).
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

    // Reflect every pan/zoom in the URL so the view is sharable. (The
    // spider's feet follow the camera inside MCO.map.colocation.)
    map.on('moveend', () => writeUrl());
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
      if (id && (id !== _selectedStation || !_sheetOpen) && stationById.has(id)) {
        coloc && coloc.close();
        goTo(id, { fromHistory: true });
      } else if (!id && _selectedStation) {
        closeStation();
      }
    } finally { _fromHistory = false; }
    writeUrl();   // sync the camera etc. into the restored entry
  });

  // ── Hover tooltip ────────────────────────────────────────────────────────
  // The tooltip is MCO.map.initCursorTooltip (kit 0.8.0): the dispatcher,
  // edge-flipped positioning, cursor: pointer and mouseout cleanup, all set
  // with textContent. The hover fan-out is MCO.map.colocation's.
  const HOVER_LAYERS = [
    'spider-layer', 'spider-id-label',
    'stations-layer', 'stations-badge', 'stations-badge-disc', 'stations-id-label',
  ];

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
  }

  // Global keyboard shortcut: / focuses search. Esc is the kit's: one stack
  // (MCO.escStack) for the dialogs, the drawer, the sheet and the spider.
  window.addEventListener('keydown', (e) => {
    if (kbdShortcuts && e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const t = e.target;
      const inField =
        t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (inField) return;
      e.preventDefault();
      // In rail or compact-drawer mode the field lives in the closed drawer:
      // open it on the field, or '/' focuses an input that is display:none
      // and the keystroke is lost.
      if (rail.isRail() || rail.isDrawerMode()) { rail.open(searchInput); return; }
      searchInput.focus();
      searchInput.select();
    }
  });
  // ── Mode toggle ──────────────────────────────────────────────────────────
  // Segmented buttons above 1400px, a <select> at and below it
  // (MCO.initSegmentedFallback, kit 0.9.0, on the ladder's 1400 rung so the
  // bar stays one row from 1061 to 1440): one value, each mirrors the
  // other, and focus follows across a breakpoint flip. The compact bar's
  // hot control is a third copy, in .mco-rail.
  const railModeSelect = document.getElementById('rail-mode-select');
  function setMode(mode) {
    if (!MODES[mode] || mode === activeMode) return;
    activeMode = mode;
    railModeSelect.value = mode;
    MCO.lsSet('mco-maint-mode', activeMode);
    refreshDotColors();
    applyAllFilters();  // category filter belongs to the active mode
    writeUrl();
  }
  const modeCtl = MCO.initSegmentedFallback({
    group: document.getElementById('mode-seg'),
    select: document.getElementById('mode-select'),
    mq: '(max-width: 1400px)',
    onChange: setMode,
  });
  modeCtl.set(activeMode);
  railModeSelect.value = activeMode;
  railModeSelect.addEventListener('change', () => {
    modeCtl.set(railModeSelect.value);
    setMode(railModeSelect.value);
    MCO.announce(`Color mode: ${railModeSelect.selectedOptions[0].textContent}.`);
  });

  // ── Refresh (manual data reload) ─────────────────────────────────────────
  // A manual refresh doesn't refly to the deep-linked station: loadAll
  // consumes ?station= only on the first load (_initStationConsumed). A
  // station that is still open gets the reloaded visit data in place.
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
      sw.dataset.shape = r.hollow ? 'hollow' : 'circle';   // the map mark is a dot
      sw.style.setProperty('--swatch', r.hollow ? dotStrokeColor() : r.color);
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

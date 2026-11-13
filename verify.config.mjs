/* verify.config.mjs — config for mco-web-style's tools/verify/ harness.
   Run from a kit checkout beside this repo:

     cd ../mco-web-style
     node tools/verify/head.mjs       --root ../mesonet-maintenance
     node tools/verify/axe-matrix.mjs --config ../mesonet-maintenance/verify.config.mjs
     node tools/verify/keyboard.mjs   --config ../mesonet-maintenance/verify.config.mjs

   Runs against the LIVE API (mesonet2.climate.umt.edu, CORS *), so it needs
   network. `root` resolves from the cwd, i.e. the kit checkout.

   Render evidence: `ready` proves the data arrived and was handed to the map
   (the sr-only twin is built from the same features as the GeoJSON source),
   and the "station dots paint" probe proves the map actually DREW them: it
   counts canvas pixels in the visited/AgriMet colors. A CSP-blocked MapLibre
   worker leaves the basemap up with nothing on it, and only that probe sees
   it. The "photos load" probe counts responses from the AirTable attachment
   host after opening a station with photos — a blocked CSS background-image
   is an empty box, not a console error.

   Station IDs here are real: aceashla (Ashland, a HydroMet station with
   visit photos) and aceabsar (Absarokee, a HydroMet station colocated with
   the AgriMet wsrabsaw), both from mesonet2's /stations/ list. */
import { load } from '../mco-web-style/tools/verify/lib.mjs';

// Serialized into the page by Playwright: no closures over module scope.
const dataReady = () => document.querySelectorAll('#sr-station-table tbody tr').length > 100;

// An open station sheet: the kit sheet, not closed, titled.
const sheetOpen = () => {
  const s = document.getElementById('station-sheet');
  return !!s && !s.hidden && s.dataset.state !== 'closed';
};

// Compliance-mode dot colors (app.js ROLE_COLORS, the same in every theme):
// visited and AgriMet as-needed, the two categories the live network always
// has many of (overdue can be zero).
const DOT_RGB = [[0x2a, 0x8a, 0x86], [0x7a, 0x8b, 0xa6]];
async function dotColors() { return DOT_RGB; }

// First pixel (in page coordinates) in the visited color, or null.
async function findDot(page) {
  const { PNG } = await load('pngjs');
  const [R, G, B] = (await dotColors(page))[0];
  const box = await page.locator('#map').boundingBox();
  const png = PNG.sync.read(await page.screenshot({ clip: box }));
  for (let y = 60; y < png.height - 60; y += 2) for (let x = 340; x < png.width - 80; x += 2) {
    const i = (y * png.width + x) * 4;
    if (Math.abs(png.data[i] - R) + Math.abs(png.data[i + 1] - G) + Math.abs(png.data[i + 2] - B) < 12) {
      return { x: box.x + x + 2, y: box.y + y + 2 };
    }
  }
  return null;
}

async function dotPixels(page) {
  const { PNG } = await load('pngjs');
  const colors = await dotColors(page);
  const box = await page.locator('#map').boundingBox();
  const png = PNG.sync.read(await page.screenshot({ clip: box }));
  let n = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    if (colors.some(([R, G, B]) => Math.abs(r - R) + Math.abs(g - G) + Math.abs(b - B) < 24)) n++;
  }
  return n;
}

export default {
  root: '../mesonet-maintenance',
  page: 'index.html',
  storage: { 'mco-maint-seen-intro': '1' },
  scenarios: [
    { name: 'default', query: '', ready: dataReady },
    { name: 'triptype+labels', query: '?mode=triptype&labels=on', ready: dataReady },
    // A hidden category with the legend open (explicitly, so a stored
    // collapse can't hide its rows from the scan).
    { name: 'legend-off', query: '?cat-compliance=visited+new&legend=open', ready: dataReady },
    // Every category hidden: the .mco-empty callout over the map.
    { name: 'empty-state', query: '?cat-compliance=', ready: () => document.querySelectorAll('#sr-station-table tbody tr').length > 100 && !document.getElementById('empty-state').hidden },
    // A station sheet open (visit history, pills, photos, links): it only
    // exists after a click, so a load-only scan never audits it.
    { name: 'station-sheet', query: '?station=aceashla&lng=-106.14&lat=45.57&zoom=9', ready: () => !!document.querySelector('#station-sheet:not([hidden]) .visit-photo-thumb') },
    // The plain ?station= deep link (no camera): flies in and opens the
    // panel, end-docked at 1440 and full height at 390. Absarokee is a
    // colocated site, so its sheet carries "Also at this site".
    { name: 'deep-link', query: '?station=aceabsar', ready: () => {
      const s = document.getElementById('station-sheet');
      return !!s && !s.hidden && s.dataset.state !== 'closed' && /Also at this site/.test(s.textContent);
    } },
    // The compact drawer open at 390 (☰ at the right edge opens a right
    // drawer). ready opens it; above compact there is no drawer to open.
    { name: 'drawer-open', query: '', ready: () => {
      if (document.querySelectorAll('#sr-station-table tbody tr').length <= 100) return false;
      if (!matchMedia('(max-width: 640px)').matches) return true;
      const d = document.getElementById('nav-drawer');
      if (!d.classList.contains('is-open')) document.getElementById('btn-rail-menu').click();
      return d.classList.contains('is-open');
    } },
    // A network chip toggled off (AgriMet hidden): Absarokee's pair resolves
    // to a plain dot and the chip reads unpressed.
    { name: 'chip-off', query: '?net=hydromet', ready: () => document.querySelectorAll('#sr-station-table tbody tr').length > 100 && document.querySelector('#subnet-filters [data-network="AgriMet"]')?.getAttribute('aria-pressed') === 'false' },
  ],
  exemptTargets: '',
  allowProblems: [],
  dialogOpener: '#btn-info',
  shortcuts: [{ key: '/', effect: () => document.activeElement?.id === 'search-input' }],
  probes: async ({ env, open, check }) => {
    // Inputs first: the page is served (200) and both live API feeds answer
    // 200 with rows, so a probe below can't pass on an empty or failed load.
    {
      const ctx = await env.browser.newContext();
      const get = async (url) => { const r = await ctx.request.get(url, { timeout: 30000 }).catch(() => null); if (!r) return [0, 0]; const t = await r.text(); let n = t.length; try { const j = JSON.parse(t); n = Array.isArray(j) ? j.length : Object.keys(j).length; } catch {} return [r.status(), n]; };
      const pg = await get(env.base + 'index.html');
      const st = await get('https://mesonet2.climate.umt.edu/api/v2/stations/?type=json');
      const mt = await get('https://mesonet2.climate.umt.edu/api/v2/stations/maintenance/live?type=json');
      check(`inputs: page ${pg[0]} (${pg[1]} bytes), /stations/ ${st[0]} (${st[1]} rows), /maintenance/live ${mt[0]} (${mt[1]} rows)`,
        pg[0] === 200 && pg[1] > 10000 && st[0] === 200 && st[1] > 100 && mt[0] === 200 && mt[1] > 0, JSON.stringify({ pg, st, mt }));
      await ctx.close();
    }
    // The map draws its data, not just the basemap.
    {
      const { page, close, problems } = await open('', { ready: dataReady, settleMs: 2500 });
      const n = await dotPixels(page);
      check(`station dots paint on the canvas (${n} px in data colors)`, n > 300, String(n));
      // Hover a dot: the cursor tooltip names the station and its status.
      const dot = await findDot(page);
      if (dot) { await page.mouse.move(dot.x - 3, dot.y - 3); await page.mouse.move(dot.x, dot.y); }
      await page.waitForTimeout(300);
      const tip = await page.evaluate(() => {
        const t = document.getElementById('tooltip');
        return { vis: t.classList.contains('visible'), text: t.textContent, cursor: document.querySelector('.maplibregl-canvas').style.cursor };
      });
      check('hovering a dot shows the tooltip (name, id, status) and a pointer', !!dot && tip.vis && /Visited this year/.test(tip.text) && tip.cursor === 'pointer', JSON.stringify(tip));
      const probs = await problems();
      check('no console / CSP problems on load', probs.length === 0, probs.slice(0, 3).join(' | '));
      // A theme flip calls setStyle, which wipes custom layers: they must
      // come back, with data.
      await page.click('#btn-theme');
      await page.waitForTimeout(4000);
      const n2 = await dotPixels(page);
      check(`station dots repaint after a theme flip (${n2} px)`, n2 > 300, String(n2));
      await close();
    }
    // CARTO down: watchBasemap falls back to a blank style with a notice,
    // and the stations are re-added on that style.load and still draw.
    // Chromium only: in Playwright's WebKit, ANY request interception
    // (ctx.route or page.route) breaks MapLibre's blob: worker ("WebKitBlobResource
    // error 1" -> "Worker failed to load"), so the map never loads there for
    // reasons unrelated to the app.
    if (env.engine === 'chromium') {
      const ctx = await env.browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'America/Denver' });
      await ctx.addInitScript(() => { try { localStorage.setItem('mco-maint-seen-intro', '1'); } catch {} });
      await ctx.route(/basemaps\.cartocdn\.com\/gl\/.*style\.json/, (r) => r.abort());
      const page = await ctx.newPage();
      await page.goto(env.base + '?theme=dark');
      await page.waitForFunction(dataReady, null, { timeout: 45000 }).catch(() => {});
      const notice = await page.waitForSelector('.mco-notice', { timeout: 30000 }).then(() => true, () => false);
      await page.waitForTimeout(2500);
      const n = await dotPixels(page);
      check(`basemap failure: notice shown and stations still paint (${n} px)`, notice && n > 300, `notice=${notice} px=${n}`);
      await ctx.close();
    }
    // Maintenance feed empty: the warning notice (#data-banner, which the
    // social-card generator checks) appears over the map with Retry, and the
    // stations still list. Chromium only, for the same reason as above.
    if (env.engine === 'chromium') {
      const ctx = await env.browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'America/Denver' });
      await ctx.addInitScript(() => { try { localStorage.setItem('mco-maint-seen-intro', '1'); } catch {} });
      await ctx.route(/\/stations\/maintenance\/live/, (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '[]' }));
      const page = await ctx.newPage();
      await page.goto(env.base + '?theme=light');
      await page.waitForFunction(dataReady, null, { timeout: 45000 }).catch(() => {});
      const st = await page.evaluate(() => {
        const b = document.getElementById('data-banner');
        return { vis: !!b && b.offsetParent !== null, text: b?.textContent || '', retry: !!b?.querySelector('.mco-notice-actions button') };
      });
      check('empty maintenance feed: #data-banner warning notice with Retry', st.vis && /Warning/.test(st.text) && st.retry, JSON.stringify(st));
      const { AxeBuilder } = await load('@axe-core/playwright');
      for (const theme of ['light', 'dark', 'high-contrast']) {
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
        await page.waitForTimeout(800);   // let color transitions finish
        const r = await new AxeBuilder({ page }).include('#data-banner').analyze();
        const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
        check(`#data-banner axe-clean in ${theme}`, bad.length === 0, bad.map((v) => v.id).join(','));
      }
      await ctx.close();
    }
    // Theme toggle cycles dark -> light -> high contrast -> dark, naming the
    // next theme; the map repaints its data in high contrast.
    {
      const { page, close } = await open('?theme=dark', { ready: dataReady });
      const seen = [];
      for (let i = 0; i < 3; i++) {
        const label = await page.getAttribute('#btn-theme', 'aria-label');
        await page.click('#btn-theme');
        await page.waitForTimeout(i === 1 ? 4000 : 1500);
        seen.push([label, await page.evaluate(() => document.documentElement.dataset.theme)]);
        if (i === 1) seen.push(['hc dots', await dotPixels(page)]);
      }
      const ok = seen[0][1] === 'light' && /light/i.test(seen[0][0]) && seen[1][1] === 'high-contrast' && /high contrast/i.test(seen[1][0])
        && seen[2][1] > 300 && seen[3][1] === 'dark' && /dark/i.test(seen[3][0]);
      check('theme toggle cycles dark -> light -> high contrast -> dark; HC repaints dots', ok, JSON.stringify(seen));
      await close();
    }
    // Landscape phones (750x342, 844x390; kit 1.0.0): the bar is a 56px rail
    // at the RIGHT edge (badge, ☰, search; the mode select hides there, a
    // select doesn't fit 56px, and the drawer carries it), the map ends at
    // the rail with zoom top right just left of it, the rail buttons are
    // >= 44px and hittable, ☰ opens the drawer beside the rail (focus in,
    // <main> inert, the drawer's mode select reachable), Esc returns focus
    // to ☰, and "/" opens the drawer on the search field.
    for (const vp of [{ name: '750x342', width: 750, height: 342, touch: true }, { name: '844x390', width: 844, height: 390, touch: true }]) {
      const { page, close } = await open('', { ready: dataReady, viewport: vp });
      const geo = await page.evaluate(() => {
        const r = (el) => el.getBoundingClientRect();
        const hit = (el) => { const b = r(el); const t = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!t && el.contains(t); };
        const nav = r(document.getElementById('navbar')), map = r(document.getElementById('map'));
        const logo = r(document.querySelector('#navbar .logo-img'));
        const zoom = document.querySelector('.maplibregl-ctrl-top-right');
        const btns = ['btn-rail-menu', 'btn-rail-search'].map((id) => document.getElementById(id));
        return { vw: innerWidth, vh: innerHeight, navL: Math.round(nav.left), navR: Math.round(nav.right), navW: Math.round(nav.width), navH: Math.round(nav.height),
          mapR: Math.round(map.right), mapH: Math.round(map.height), zoomR: zoom ? Math.round(r(zoom).right) : null, zoomT: zoom ? Math.round(r(zoom).top) : null,
          order: [Math.round(logo.top), ...btns.map((b) => Math.round(r(b).top))],
          sizes: btns.map((b) => [Math.round(r(b).width), Math.round(r(b).height)]), hit: btns.map(hit),
          selShown: document.getElementById('rail-mode-select').checkVisibility(), isRail: document.documentElement.classList.contains('is-rail') };
      });
      check(`${vp.name}: rail at the right edge (56px, full height; badge, ☰, search top to bottom; buttons >= 44px and hittable; mode select hidden), map ends at it, zoom top right left of it`,
        geo.isRail && geo.navW <= 60 && geo.navR >= geo.vw - 1 && geo.navL >= geo.vw - 61 && geo.navH >= geo.vh - 1 && geo.mapR <= geo.navL + 1 && geo.mapH >= geo.vh - 12
          && geo.order[0] < geo.order[1] && geo.order[1] < geo.order[2] && geo.sizes.every(([w, h]) => w >= 44 && h >= 44) && geo.hit.every(Boolean)
          && !geo.selShown && geo.zoomR !== null && geo.zoomR <= geo.navL + 1 && geo.zoomR >= geo.navL - 12 && geo.zoomT <= 12,
        JSON.stringify(geo));
      await page.click('#btn-rail-menu');
      await page.waitForTimeout(500);
      const o = await page.evaluate(() => {
        const d = document.getElementById('nav-drawer').getBoundingClientRect(), nav = document.getElementById('navbar').getBoundingClientRect();
        return { inDrawer: document.getElementById('nav-drawer').contains(document.activeElement), field: document.activeElement?.tagName, mainInert: document.getElementById('main').inert,
          dR: Math.round(d.right), dL: Math.round(d.left), navL: Math.round(nav.left), sel: document.getElementById('mode-select').checkVisibility() || document.getElementById('mode-seg').checkVisibility() };
      });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      const c = await page.evaluate(() => [document.activeElement?.id, document.getElementById('main').inert]);
      await page.keyboard.press('/');
      await page.waitForTimeout(400);
      const sl = await page.evaluate(() => document.activeElement?.id);
      check(`${vp.name}: ☰ opens the drawer beside the rail (focus in, not a field; <main> inert; the mode control in it); Esc -> ☰; "/" -> search`,
        o.inDrawer && o.field !== 'INPUT' && o.mainInert && o.dR <= o.navL + 1 && o.dR >= o.navL - 1 && o.dL > 0 && o.sel && c[0] === 'btn-rail-menu' && !c[1] && sl === 'search-input',
        JSON.stringify({ o, c, sl }));
      await close();
    }
    // Color mode: segmented buttons at 1440, a <select> at <=1060 — one value.
    {
      const { page, close } = await open('', { ready: dataReady });
      await page.locator('#mode-seg [data-value="timesince"]').click();
      await page.waitForTimeout(300);
      const a = await page.evaluate(() => ({ q: location.search, t: document.getElementById('legend-title').textContent, sel: document.getElementById('mode-select').value }));
      await page.setViewportSize({ width: 1000, height: 800 });
      await page.waitForTimeout(400);
      const vis = await page.evaluate(() => [document.getElementById('mode-seg').hidden, document.getElementById('mode-select').hidden]);
      // At 1000px the bar folds (kit 0.21.0), so the select is in the closed ☰ drawer.
      if (!(await page.locator('#mode-select').isVisible())) { await page.click('#btn-rail-menu'); await page.waitForTimeout(400); }
      await page.selectOption('#mode-select', 'triptype');
      await page.waitForTimeout(300);
      const b = await page.evaluate(() => ({ q: location.search, t: document.getElementById('legend-title').textContent, pressed: document.querySelector('#mode-seg [aria-pressed="true"]')?.dataset.value }));
      check('mode: buttons at 1440, <select> at 1000, mirrored, legend + ?mode= follow',
        /mode=timesince/.test(a.q) && a.sel === 'timesince' && /Since last/.test(a.t) && vis[0] && !vis[1] && /mode=triptype/.test(b.q) && /trip type/i.test(b.t) && b.pressed === 'triptype',
        JSON.stringify({ a, vis, b }));
      await close();
    }
    // Legend: click hides a category (and drops it from the map + URL);
    // Shift+Enter isolates.
    {
      const { page, close } = await open('?legend=open', { ready: dataReady });
      const row = page.locator('#legend-rows [data-key="as_needed"]');
      await row.click();
      await page.waitForTimeout(600);
      const st = await page.evaluate(() => ({
        pressed: document.querySelector('#legend-rows [data-key="as_needed"]').getAttribute('aria-pressed'),
        q: location.search,
        rows: document.querySelectorAll('#sr-station-table tbody tr').length,
      }));
      check('legend click hides a category (aria-pressed=false, cat- in URL)', st.pressed === 'false' && /cat-compliance=/.test(st.q), JSON.stringify(st));
      await page.locator('#legend-rows [data-key="visited"]').focus();
      await page.keyboard.press('Shift+Enter');
      await page.waitForTimeout(300);
      const iso = await page.evaluate(() => [...document.querySelectorAll('#legend-rows [data-key]')].map((r) => r.dataset.key + ':' + r.getAttribute('aria-pressed')).join(','));
      check('Shift+Enter isolates a legend category', /visited:true/.test(iso) && !/(overdue|new|as_needed):true/.test(iso), iso);
      await close();
    }
    // Search: type, Enter picks the best match, the map flies and opens it.
    {
      const { page, close } = await open('', { ready: dataReady });
      await page.locator('#search-input').fill('ashla');
      await page.waitForTimeout(300);
      const opts = await page.locator('#search-dropdown [role="option"]:not([aria-disabled])').count();
      await page.keyboard.press('Enter');
      const opened = await page.waitForFunction(() => /Ashland/.test(document.getElementById('station-sheet-title').textContent) && !document.getElementById('station-sheet').hidden, null, { timeout: 15000 }).then(() => true, () => false);
      check(`search lists matches (${opts}) and Enter opens that station's sheet`, opts > 0 && opened);
      await close();
    }
    // Compact (kit 1.0.0): a station opens the ONE-state panel, full height
    // under the bar (390x844) or left of the rail (844x390): its rect is the
    // viewport less the bar, <main> inert, the bar live. The 44px close
    // button sits top right and is hittable. The lightbox still works from
    // it (not inert, Next steps), its Esc closes only the lightbox, and Esc
    // then closes the panel and drops ?station=.
    for (const vp of [{ name: '390x844', width: 390, height: 844, touch: true }, { name: '844x390', width: 844, height: 390, touch: true }]) {
      const { page, close } = await open('?station=aceashla&lng=-106.14&lat=45.57&zoom=9', { ready: dataReady, viewport: vp });
      const full = await page.waitForSelector('#station-sheet[data-state="full"]', { timeout: 15000 }).then(() => true, () => false);
      await page.waitForTimeout(600);
      const st = await page.evaluate(() => {
        const r = (el) => el.getBoundingClientRect();
        const sh = r(document.getElementById('station-sheet')), nav = r(document.getElementById('navbar'));
        const x = document.querySelector('#station-sheet [data-close-sheet]'), xb = r(x);
        const t = document.elementFromPoint(xb.left + xb.width / 2, xb.top + xb.height / 2);
        const rail = document.documentElement.classList.contains('is-rail');
        return { vw: innerWidth, vh: innerHeight, rail, sh: [sh.left, sh.top, sh.right, sh.bottom].map(Math.round), nav: [nav.left, nav.bottom].map(Math.round),
          title: document.getElementById('station-sheet-title').textContent, focus: document.activeElement?.id,
          grip: !!document.querySelector('#station-sheet .mco-sheet-grip, #station-sheet [data-peek]'),
          popups: document.querySelectorAll('.maplibregl-popup').length,
          mainInert: document.getElementById('main').inert, navInert: document.getElementById('navbar').inert || !!document.getElementById('navbar').closest('[inert]'),
          close: [Math.round(xb.width), Math.round(xb.height), Math.round(sh.right - xb.right), Math.round(xb.top - sh.top)], closeHit: !!t && x.contains(t) };
      });
      const want = st.rail ? [0, 0, st.nav[0], st.vh] : [0, st.nav[1], st.vw, st.vh];
      check(`${vp.name}: deep link opens the full-height panel (state full, rect = viewport less the bar, no grip/peek, no popup), focus on its title`,
        full && st.sh.every((v, i) => Math.abs(v - want[i]) <= 1) && !st.grip && st.popups === 0 && st.title === 'Ashland' && st.focus === 'station-sheet-title', JSON.stringify({ full, want, ...st }));
      check(`${vp.name}: panel modal with the bar live (<main> inert, navbar not); close button 44px top right and hittable`,
        st.mainInert && !st.navInert && st.close[0] >= 44 && st.close[1] >= 44 && st.close[2] <= 16 && st.close[3] <= 16 && st.closeHit, JSON.stringify(st));
      await page.locator('#station-sheet .visit-photo-thumb').first().click();
      const lb = await page.waitForFunction(() => document.getElementById('lightbox').open && document.getElementById('lightbox-img').naturalWidth > 0, null, { timeout: 15000 }).then(() => true, () => false);
      // Usable over the modal panel: not inert, and Next steps the gallery.
      const cap0 = await page.textContent('#lightbox-caption');
      await page.click('#lightbox-next');
      await page.waitForTimeout(300);
      const lbUse = await page.evaluate((c0) => ({ inert: document.getElementById('lightbox').inert || !!document.getElementById('lightbox').closest('[inert]'), stepped: document.getElementById('lightbox-caption').textContent !== c0 }), cap0);
      check(`${vp.name}: lightbox over the panel is live (not inert) and Next steps the gallery`, lb && !lbUse.inert && lbUse.stepped, JSON.stringify({ lb, ...lbUse }));
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      const after1 = await page.evaluate(() => ({ lb: document.getElementById('lightbox').open, st: document.getElementById('station-sheet').dataset.state }));
      check(`${vp.name}: the lightbox's Esc closes only the lightbox`, !after1.lb && after1.st === 'full', JSON.stringify(after1));
      // The info dialog opens over the panel too (the bar is live, so its ?
      // button is reachable in the drawer; click it directly).
      await page.evaluate(() => document.getElementById('btn-info').click());
      await page.waitForTimeout(400);
      const info = await page.evaluate(() => { const d = document.getElementById('info-modal'); return { open: d.open, inert: d.inert || !!d.closest('[inert]') }; });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      const info2 = await page.evaluate(() => ({ open: document.getElementById('info-modal').open, st: document.getElementById('station-sheet').dataset.state }));
      check(`${vp.name}: the info dialog opens over the panel, live; its Esc leaves the panel open`, info.open && !info.inert && !info2.open && info2.st === 'full', JSON.stringify({ info, info2 }));
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      const after = await page.evaluate(() => ({ st: document.getElementById('station-sheet').dataset.state, q: location.search, inert: document.getElementById('main').inert }));
      check(`${vp.name}: Esc closes the panel, un-inerts <main>, drops ?station=`, after.st === 'closed' && !after.inert && !/station=/.test(after.q), JSON.stringify(after));
      await close();
    }
    // The bar stays live under the panel at 390: search in the bar swaps
    // the station with the panel open, and the close button closes it.
    {
      const { page, close } = await open('?station=aceashla', { ready: dataReady, viewport: { name: '390', width: 390, height: 844, touch: true } });
      await page.waitForFunction(sheetOpen, null, { timeout: 20000 });
      await page.click('#btn-rail-search');
      await page.waitForTimeout(400);
      const sf = await page.evaluate(() => document.activeElement?.id);
      await page.keyboard.type('absar');
      await page.waitForTimeout(300);
      await page.keyboard.press('Enter');
      const swapped = await page.waitForFunction(() => /Absarokee/.test(document.getElementById('station-sheet-title').textContent), null, { timeout: 20000 }).then(() => true, () => false);
      await page.waitForTimeout(400);
      await page.click('#station-sheet [data-close-sheet]');
      await page.waitForTimeout(500);
      const st = await page.evaluate(() => ({ st: document.getElementById('station-sheet').dataset.state, inert: document.getElementById('main').inert, q: location.search }));
      check('390: with the panel open the bar\'s search swaps the station; the close button closes it', sf === 'search-input' && swapped && st.st === 'closed' && !st.inert && !/station=/.test(st.q), JSON.stringify({ sf, swapped, st }));
      await close();
    }
    // Dialogs from inside an open overlay (kit 1.0.0 RC 3): the info dialog
    // opened from the ☰ drawer at 390 and 844x390 is live with focus inside,
    // Esc closes it, and focus returns to its opener (?) in the drawer, which
    // stays open. The lightbox opened from a thumb in the open panel returns
    // focus to that thumb. The app closes neither overlay first.
    for (const vp of [{ name: '390x844', width: 390, height: 844, touch: true }, { name: '844x390', width: 844, height: 390, touch: true }]) {
      const { page, close } = await open('', { ready: dataReady, viewport: vp });
      await page.click('#btn-rail-menu');
      await page.waitForTimeout(500);
      await page.click('#btn-info');
      await page.waitForTimeout(500);
      const d = await page.evaluate(() => { const m = document.getElementById('info-modal'); return { open: m.open, modal: m.matches(':modal'), inert: m.inert || !!m.closest('[inert]'), focusIn: m.contains(document.activeElement) }; });
      // Live: its close button takes a real click.
      const hit = await page.evaluate(() => { const b = document.querySelector('#info-modal [data-close-modal]').getBoundingClientRect(); const t = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!t && !!t.closest('#info-modal'); });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      const a2 = await page.evaluate(() => ({ open: document.getElementById('info-modal').open, focus: document.activeElement?.id, drawer: document.getElementById('nav-drawer').classList.contains('is-open') }));
      check(`${vp.name}: info dialog from the open ☰ drawer is live (modal, focus inside, hittable); Esc closes it, focus back on ? in the still-open drawer`,
        d.open && d.modal && !d.inert && d.focusIn && hit && !a2.open && a2.focus === 'btn-info' && a2.drawer, JSON.stringify({ d, hit, a2 }));
      await close();
    }
    for (const vp of [{ name: '390x844', width: 390, height: 844, touch: true }, { name: '1440', width: 1440, height: 900 }]) {
      const { page, close } = await open('?station=aceashla&lng=-106.14&lat=45.57&zoom=9', { ready: dataReady, viewport: vp });
      await page.waitForSelector('#station-sheet .visit-photo-thumb', { timeout: 15000 }).catch(() => {});
      const thumb = page.locator('#station-sheet .visit-photo-thumb').first();
      await thumb.click();
      const lb = await page.waitForFunction(() => document.getElementById('lightbox').open, null, { timeout: 15000 }).then(() => true, () => false);
      const inLb = await page.evaluate(() => { const l = document.getElementById('lightbox'); return { focusIn: l.contains(document.activeElement), inert: l.inert || !!l.closest('[inert]') }; });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      const back = await page.evaluate(() => ({ open: document.getElementById('lightbox').open, onThumb: document.activeElement === document.querySelector('#station-sheet .visit-photo-thumb'), st: document.getElementById('station-sheet').dataset.state }));
      check(`${vp.name}: lightbox from the open panel is live with focus inside; Esc closes it and returns focus to the thumb, panel still open`,
        lb && inLb.focusIn && !inLb.inert && !back.open && back.onThumb && back.st === 'full', JSON.stringify({ lb, inLb, back }));
      await close();
    }
    // The legend (kit 1.0.0, MCO.initLegendDrawer): at 390 it is a "Legend"
    // group at the end of the ☰ drawer and a Legend button sits in its
    // bottom-left corner on the map; the button opens the drawer with the
    // legend expanded and focus on its title, its rows still toggle, and Esc
    // returns focus to the button. At 1440 the panel floats, no button.
    {
      const { page, close } = await open('?legend=collapsed', { ready: dataReady, viewport: { name: '390', width: 390, height: 844, touch: true } });
      const a = await page.evaluate(() => {
        const b = document.querySelector('.mco-legend-btn'), r = b && b.getBoundingClientRect(), m = document.getElementById('map').getBoundingClientRect();
        const t = r && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { btn: !!b && !b.hidden, name: b?.textContent.trim(), h: r && Math.round(r.height), inMap: !!r && r.left >= m.left && r.bottom <= m.bottom && r.left < m.left + 40,
          hit: !!t && b.contains(t), slot: !!document.querySelector('#nav-drawer .mco-legend-slot #legend'), group: document.querySelector('#nav-drawer .mco-legend-slot')?.getAttribute('aria-label') };
      });
      await page.click('.mco-legend-btn');
      await page.waitForTimeout(500);
      const o = await page.evaluate(() => ({ open: document.getElementById('nav-drawer').classList.contains('is-open'), focus: document.activeElement?.id,
        expanded: document.getElementById('legend-toggle-btn').getAttribute('aria-expanded'), rowShown: document.querySelector('#legend-rows [data-key="as_needed"]')?.checkVisibility() }));
      await page.locator('#legend-rows [data-key="as_needed"]').click();
      await page.waitForTimeout(400);
      const t = await page.evaluate(() => ({ pressed: document.querySelector('#legend-rows [data-key="as_needed"]').getAttribute('aria-pressed'), q: location.search }));
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      const c = await page.evaluate(() => ({ open: document.getElementById('nav-drawer').classList.contains('is-open'), focusBtn: document.activeElement?.classList.contains('mco-legend-btn') }));
      check('390: legend in a "Legend" drawer group; the Legend button (>= 40px, on the map, hittable) opens it expanded with focus on its title; rows toggle; Esc -> button',
        a.btn && a.name === 'Legend' && a.h >= 40 && a.inMap && a.hit && a.slot && a.group === 'Legend' && o.open && o.focus === 'legend-title' && o.expanded === 'true' && o.rowShown
          && t.pressed === 'false' && /cat-compliance=/.test(t.q) && !c.open && c.focusBtn, JSON.stringify({ a, o, t, c }));
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForTimeout(600);
      const d = await page.evaluate(() => { const l = document.getElementById('legend'), m = document.getElementById('map').getBoundingClientRect(), r = l.getBoundingClientRect();
        return { floating: !l.classList.contains('is-in-drawer') && !!l.closest('#map-container'), inMap: r.left >= m.left && r.bottom <= m.bottom, btnHidden: document.querySelector('.mco-legend-btn').hidden }; });
      check('1440: the legend floats over the map again (no Legend button)', d.floating && d.inMap && d.btnHidden, JSON.stringify(d));
      await close();
    }
    // Touch tablet (768x1024, legend floating): the legend sits clear above
    // the 44px two-line attribution; at 1440 with a mouse it keeps its 36px
    // bottom inset.
    for (const vp of [{ name: '768x1024 touch', width: 768, height: 1024, touch: true }, { name: '1440 mouse', width: 1440, height: 900 }]) {
      const { page, close } = await open('?legend=open', { ready: dataReady, viewport: vp, settleMs: 1000 });
      const g = await page.evaluate(() => {
        const R = (el) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom].map(Math.round); };
        const l = R(document.getElementById('legend')), a = R(document.querySelector('#map .maplibregl-ctrl-attrib')), m = R(document.getElementById('map'));
        const ox = Math.min(l[2], a[2]) - Math.max(l[0], a[0]), oy = Math.min(l[3], a[3]) - Math.max(l[1], a[1]);
        return { legend: l, attrib: a, overlap: ox > 0 && oy > 0 ? [ox, oy] : null, bottomInset: m[3] - l[3] };
      });
      const ok = vp.touch ? !g.overlap : g.bottomInset === 36;
      check(`${vp.name}: legend ${g.legend.join(',')} vs attribution ${g.attrib.join(',')} — ${vp.touch ? 'no overlap' : 'bottom inset 36px (unchanged)'}`, ok, JSON.stringify(g));
      await close();
    }
    // The bar never grows past one row while the sub-network chips arrive
    // from the live API (seconds after load): sample its height every 100ms
    // from 1s after navigation until the chips have been in for 2s (or 12s).
    // A ResizeObserver also records every height the bar takes, so a change
    // between samples (timers run late while MapLibre loads) is caught too.
    for (const vp of [{ width: 390, height: 844 }, { width: 980, height: 1700 }]) {
      const ctx = await env.browser.newContext({ viewport: vp, hasTouch: true, timezoneId: 'America/Denver' });
      await ctx.addInitScript(() => {
        try { localStorage.setItem('mco-maint-seen-intro', '1'); } catch {}
        window.__barSamples = [];
        window.__barMaxRO = 0;
        const t0 = performance.now();
        new MutationObserver((_, mo) => {
          const n = document.getElementById('navbar');
          if (!n) return;
          mo.disconnect();
          new ResizeObserver(() => { if (performance.now() - t0 >= 1000) window.__barMaxRO = Math.max(window.__barMaxRO, Math.round(n.getBoundingClientRect().height)); }).observe(n);
        }).observe(document, { childList: true, subtree: true });
        setInterval(() => {
          const n = document.getElementById('navbar');
          if (!n || performance.now() - t0 < 1000) return;
          window.__barSamples.push([Math.round(performance.now() - t0), Math.round(n.getBoundingClientRect().height), document.querySelectorAll('#subnet-filters .mco-chip').length]);
        }, 100);
      });
      const page = await ctx.newPage();
      const resp = await page.goto(env.base);
      check(`${vp.width}x${vp.height} sampler: page served (${resp ? resp.status() : 'no response'})`, !!resp && resp.status() === 200);
      const chips = await page.waitForFunction(() => document.querySelectorAll('#subnet-filters .mco-chip').length > 0, null, { timeout: 12000 }).then(() => true, () => false);
      // Keep sampling until a sample lands 2s after the chips (timers can run
      // late under load, so wait on the samples, not the clock).
      await page.waitForFunction(() => { const s = window.__barSamples, f = s.find((x) => x[2] > 0); return !!f && s[s.length - 1][0] >= f[0] + 2000; }, null, { timeout: 15000 }).catch(() => {});
      const { s, ro } = await page.evaluate(() => ({ s: window.__barSamples, ro: window.__barMaxRO }));
      const max = Math.max(...s.map((x) => x[1]), ro);
      const firstChip = s.find((x) => x[2] > 0);
      const after = firstChip ? s.filter((x) => x[0] > firstChip[0]).length : 0;
      check(`${vp.width}x${vp.height} touch: bar <= 64px at every 100ms sample after 1s while the chips arrive (${s.length} samples, ${after} after the chips; max ${max}px incl. ResizeObserver; chips at ${firstChip ? firstChip[0] : '-'}ms)`,
        chips && s.length >= 10 && after >= 5 && max <= 64, JSON.stringify({ chips, n: s.length, after, max, ro, firstChip, last: s[s.length - 1] }));
      await ctx.close();
    }
    // Drill-down history: opening a station pushes ONE entry; Back closes it,
    // Forward reopens it; Esc on a pushed station steps back over its entry.
    {
      const { page, close } = await open('', { ready: dataReady });
      const len0 = await page.evaluate(() => history.length);
      await page.locator('#search-input').fill('ashla');
      await page.waitForTimeout(300);
      await page.keyboard.press('Enter');
      await page.waitForFunction(sheetOpen, null, { timeout: 15000 });
      await page.waitForTimeout(500);
      const a = await page.evaluate(() => ({ len: history.length, q: location.search, popups: document.querySelectorAll('.maplibregl-popup').length }));
      await page.goBack();
      await page.waitForTimeout(800);
      const b = await page.evaluate(() => ({ popup: !document.getElementById('station-sheet').hidden && document.getElementById('station-sheet').dataset.state !== 'closed', q: location.search }));
      await page.goForward();
      await page.waitForFunction(sheetOpen, null, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(500);
      const c = await page.evaluate((t) => ({ popup: /Ashland/.test(document.getElementById('station-sheet-title').textContent) && document.getElementById('station-sheet').dataset.state !== 'closed', q: location.search }));
      await page.keyboard.press('Escape');
      await page.waitForTimeout(800);
      const d = await page.evaluate(() => ({ popup: document.getElementById('station-sheet').dataset.state !== 'closed', q: location.search }));
      check('1440: station opens the end-docked sheet (no popup) and pushes one entry; Back closes, Forward reopens, Esc steps back',
        a.popups === 0 && a.len === len0 + 1 && /station=aceashla/.test(a.q) && !b.popup && !/station=/.test(b.q) && c.popup && /station=aceashla/.test(c.q) && !d.popup && !/station=/.test(d.q),
        JSON.stringify({ len0, a, b, c, d }));
      await close();
    }
    // Deep link opens the sheet, and its visit photos actually load.
    {
      const { page, close, problems } = await open('?station=aceashla&lng=-106.14&lat=45.57&zoom=9', { ready: dataReady, settleMs: 500 });
      await page.waitForSelector('#station-sheet .visit-photo-thumb', { timeout: 15000 }).catch(() => {});
      const thumbs = await page.locator('#station-sheet .visit-photo-thumb').count();
      check(`?station= deep link opens the sheet with photo thumbs (${thumbs})`, thumbs > 0);
      // Background images start loading as the thumbs render; give them time.
      // Resource Timing lists every fetched image, CSS backgrounds included; a
      // CSP-blocked one never gets an entry (and shows up in problems()).
      const photosLoaded = () => page.evaluate(() => performance.getEntriesByType('resource')
        .filter((e) => /airtableusercontent\.com/.test(e.name) && e.responseEnd > 0).length);
      let photos = 0;
      for (let i = 0; i < 40 && !(photos = await photosLoaded()); i++) await page.waitForTimeout(250);
      // Reading the computed style proves the url() survived intact.
      const bg = await page.locator('#station-sheet .visit-photo-thumb').first()
        .evaluate((el) => getComputedStyle(el).backgroundImage).catch(() => '');
      check(`visit photos load from *.airtableusercontent.com (${photos} responses)`, photos > 0 && /airtableusercontent/.test(bg), bg.slice(0, 80));
      await page.locator('#station-sheet .visit-photo-thumb').first().click();
      const lb = await page.waitForFunction(() => {
        const i = document.getElementById('lightbox-img');
        return document.getElementById('lightbox').open && i.complete && i.naturalWidth > 0;
      }, null, { timeout: 15000 }).then(() => true, () => false);
      check('thumb opens the lightbox and the full photo loads', lb);
      check('?station= re-emits in the URL', /station=aceashla/.test(await page.evaluate(() => location.search)));
      const probs = await problems();
      check('no console / CSP problems with a sheet + lightbox open', probs.length === 0, probs.slice(0, 3).join(' | '));
      await close();
    }
    // Kit 0.21.0 conformance. ?station= (no camera) opens the panel at 1440
    // (end-docked) and at 390 (full height), never an anchored popup. Once
    // closed, a manual Refresh must not re-open it (_initStationConsumed).
    for (const vp of [{ name: '1440', width: 1440, height: 900 }, { name: '390', width: 390, height: 844, touch: true }]) {
      const { page, close } = await open('?station=aceabsar', { ready: dataReady, viewport: vp });
      const opened = await page.waitForFunction(sheetOpen, null, { timeout: 20000 }).then(() => true, () => false);
      const st = await page.evaluate(() => ({
        title: document.getElementById('station-sheet-title').textContent,
        popups: document.querySelectorAll('.maplibregl-popup').length,
        also: /Also at this site/.test(document.getElementById('station-sheet').textContent),
        right: Math.round(document.getElementById('station-sheet').getBoundingClientRect().right),
        bottom: Math.round(document.getElementById('station-sheet').getBoundingClientRect().bottom),
        q: location.search,
      }));
      check(`${vp.name}: ?station=aceabsar opens the sheet (Absarokee, "Also at this site", no popup)`,
        opened && st.title === 'Absarokee' && st.popups === 0 && st.also && /station=aceabsar/.test(st.q), JSON.stringify(st));
      await page.click('#station-sheet [data-close-sheet]');
      await page.waitForTimeout(600);
      const closed = await page.evaluate(() => ({ st: document.getElementById('station-sheet').dataset.state, q: location.search }));
      // Refresh lives in the drawer on a phone; the click goes to the button either way.
      await page.evaluate(() => document.getElementById('btn-refresh').click());
      await page.waitForFunction(() => /^Updated /.test(document.getElementById('refresh-stamp').textContent), null, { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(4000);
      const after = await page.evaluate(() => ({ st: document.getElementById('station-sheet').dataset.state, q: location.search, stamp: document.getElementById('refresh-stamp').textContent }));
      check(`${vp.name}: closing the deep-linked sheet drops ?station=, and Refresh does not re-open it`,
        closed.st === 'closed' && !/station=/.test(closed.q) && after.st === 'closed' && !/station=/.test(after.q) && /^Updated .* M[SD]T$/.test(after.stamp),
        JSON.stringify({ closed, after }));
      await close();
    }
    // 390: the one-row phone bar (badge left, mode select, search, ☰ right),
    // the right drawer with the drawer contract, Back closing a sheet opened
    // from search, and the hot control mirroring the drawer's mode control.
    {
      const vp = { name: '390', width: 390, height: 844, touch: true };
      const { page, close } = await open('', { ready: dataReady, viewport: vp });
      const bar = await page.evaluate(() => {
        const r = (id) => document.getElementById(id).getBoundingClientRect();
        const nav = document.getElementById('navbar').getBoundingClientRect();
        const logo = document.querySelector('#navbar .logo-img').getBoundingClientRect();
        return { navH: Math.round(nav.height), logoL: Math.round(logo.left), logoW: Math.round(logo.width),
          menuR: Math.round(r('btn-rail-menu').right), selL: Math.round(r('rail-mode-select').left), searchL: Math.round(r('btn-rail-search').left),
          menuL: Math.round(r('btn-rail-menu').left), vw: innerWidth,
          heights: ['btn-rail-menu', 'rail-mode-select', 'btn-rail-search'].map((id) => Math.round(r(id).height)) };
      });
      check('390: one-row bar <= 64px: badge at the left edge, mode select, search, ☰ at the right edge, all 40px',
        bar.navH <= 64 && bar.logoW > 0 && bar.logoL < 24 && bar.logoL < bar.selL && bar.selL < bar.searchL && bar.searchL < bar.menuL && bar.menuR > bar.vw - 24 && bar.heights.every((h) => h === 40),
        JSON.stringify(bar));
      await page.click('#btn-rail-menu');
      await page.waitForTimeout(400);
      const o = await page.evaluate(() => {
        const d = document.getElementById('nav-drawer').getBoundingClientRect();
        return { open: document.getElementById('nav-drawer').classList.contains('is-open'), inDrawer: document.getElementById('nav-drawer').contains(document.activeElement),
          mainInert: document.getElementById('main').inert, right: Math.round(d.right), left: Math.round(d.left), vw: innerWidth,
          stamp: document.querySelector('#nav-drawer .refresh-status')?.offsetParent !== null };
      });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      const c = await page.evaluate(() => ({ focus: document.activeElement?.id, mainInert: document.getElementById('main').inert, open: document.getElementById('nav-drawer').classList.contains('is-open') }));
      check('390: ☰ opens a right drawer (focus in, <main> inert, stamp shown); Esc closes it and returns focus to ☰',
        o.open && o.inDrawer && o.mainInert && o.right >= o.vw - 1 && o.left > 0 && o.stamp && !c.open && c.focus === 'btn-rail-menu' && !c.mainInert,
        JSON.stringify({ o, c }));
      // The hot control: the bar's select sets the mode, and the drawer's copy follows.
      await page.selectOption('#rail-mode-select', 'timesince');
      await page.waitForTimeout(400);
      const m = await page.evaluate(() => ({ q: location.search, t: document.getElementById('legend-title').textContent, drawer: document.getElementById('mode-select').value }));
      check('390: the bar\'s mode select sets the mode; the drawer copy, legend and ?mode= follow',
        /mode=timesince/.test(m.q) && /Since last/.test(m.t) && m.drawer === 'timesince', JSON.stringify(m));
      // Search from the bar: the button opens the drawer on the field; a pick
      // opens the sheet with one pushed entry, and Back closes it.
      const len0 = await page.evaluate(() => history.length);
      await page.click('#btn-rail-search');
      await page.waitForTimeout(400);
      const sf = await page.evaluate(() => document.activeElement?.id);
      await page.keyboard.type('absar');
      await page.waitForTimeout(300);
      await page.keyboard.press('Enter');
      const op = await page.waitForFunction(sheetOpen, null, { timeout: 20000 }).then(() => true, () => false);
      await page.waitForTimeout(400);
      const a = await page.evaluate(() => ({ len: history.length, q: location.search, drawer: document.getElementById('nav-drawer').classList.contains('is-open') }));
      await page.goBack();
      await page.waitForTimeout(900);
      const b = await page.evaluate(() => ({ st: document.getElementById('station-sheet').dataset.state, q: location.search }));
      check('390: search button -> drawer on the field; a pick opens the sheet (one push), Back closes it',
        sf === 'search-input' && op && !a.drawer && a.len === len0 + 1 && /station=aceabsar/.test(a.q) && b.st === 'closed' && !/station=/.test(b.q),
        JSON.stringify({ sf, op, a, b, len0 }));
      await close();
    }
    // A network chip toggle (.mco-chip[aria-pressed]): AgriMet off drops its
    // stations from the map and the table, resolves Absarokee's colocated
    // pair to a plain dot, and writes ?net=.
    {
      const { page, close } = await open('', { ready: dataReady });
      const before = await page.evaluate(() => ({ rows: document.querySelectorAll('#sr-station-table tbody tr').length,
        site: [...document.querySelectorAll('#sr-station-table tbody tr')].find((tr) => /aceabsar/.test(tr.textContent))?.textContent || '' }));
      await page.click('#subnet-filters [data-network="AgriMet"]');
      await page.waitForTimeout(600);
      const after = await page.evaluate(() => ({ rows: document.querySelectorAll('#sr-station-table tbody tr').length,
        pressed: document.querySelector('#subnet-filters [data-network="AgriMet"]').getAttribute('aria-pressed'),
        cls: document.querySelector('#subnet-filters [data-network="AgriMet"]').className, q: location.search,
        site: [...document.querySelectorAll('#sr-station-table tbody tr')].find((tr) => /aceabsar/.test(tr.textContent))?.textContent || '' }));
      check('AgriMet chip off: aria-pressed=false, fewer rows, ?net=hydromet, Absarokee no longer a 2-station site',
        /mco-chip/.test(after.cls) && after.pressed === 'false' && after.rows < before.rows && after.rows > 100 && /net=hydromet/.test(after.q) && /2 stations at this site/.test(before.site) && !/stations at this site/.test(after.site),
        JSON.stringify({ before: { rows: before.rows, site: before.site }, after }));
      await close();
    }
  },
};

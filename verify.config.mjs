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

// Compliance-mode dot colors: the kit's maintenance-compliance set
// (MCO.palette.categorySet, kit 0.21.0), visited and AgriMet as-needed —
// the two categories the live network always has many of (overdue can be
// zero). Dark and high contrast share the dark values.
const DOT_RGB = {
  dark:  [[0xc0, 0xec, 0xb2], [0xb3, 0xc1, 0xd4]],
  light: [[0x03, 0x37, 0x22], [0x4a, 0x48, 0x5b]],
};
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
async function dotColors(page) {
  // Read from the kit at run time, so a kit set change can't strand the probe.
  const rgb = await page.evaluate(() => {
    const t = document.documentElement.dataset.theme;
    const set = MCO.palette.categorySet('maintenance-compliance', t);
    return ['visited', 'as_needed'].map((k) => set.find((r) => r.key === k).color);
  }).catch(() => null);
  if (rgb) return rgb.map(hex);
  const t = await page.evaluate(() => document.documentElement.dataset.theme);
  return DOT_RGB[t === 'light' ? 'light' : 'dark'];
}

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
    // A hidden category with the legend open: the 390 default starts with
    // the legend collapsed, so without this its rows are never measured.
    { name: 'legend-off', query: '?cat-compliance=visited+new&legend=open', ready: dataReady },
    // Every category hidden: the .mco-empty callout over the map.
    { name: 'empty-state', query: '?cat-compliance=', ready: () => document.querySelectorAll('#sr-station-table tbody tr').length > 100 && !document.getElementById('empty-state').hidden },
    // A station sheet open (visit history, pills, photos, links): it only
    // exists after a click, so a load-only scan never audits it.
    { name: 'station-sheet', query: '?station=aceashla&lng=-106.14&lat=45.57&zoom=9', ready: () => !!document.querySelector('#station-sheet:not([hidden]) .visit-photo-thumb') },
    // The plain ?station= deep link (no camera): flies in and opens the
    // sheet, end-docked at 1440 and a bottom sheet at 390. Absarokee is a
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
    // Landscape phone (750x342): the bar is a 56px rail; the menu opens the
    // drawer (focus in, <main> inert), Esc returns focus to the toggle, and
    // "/" opens the drawer on the search field.
    {
      const { page, close } = await open('', { ready: dataReady, viewport: { name: 'land', width: 750, height: 342, touch: true } });
      const geo = await page.evaluate(() => [document.getElementById('navbar').getBoundingClientRect().width, document.getElementById('map').getBoundingClientRect().height]);
      await page.click('#btn-rail-menu');
      await page.waitForTimeout(400);
      const o = await page.evaluate(() => [document.getElementById('nav-drawer').contains(document.activeElement), document.getElementById('main').inert]);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      const c = await page.evaluate(() => [document.activeElement?.id, document.getElementById('main').inert]);
      await page.keyboard.press('/');
      await page.waitForTimeout(400);
      const sl = await page.evaluate(() => document.activeElement?.id);
      check('750x342: rail (56px, map full height); drawer focus/inert/Esc; "/" -> search',
        geo[0] <= 60 && geo[1] >= 330 && o[0] && o[1] && c[0] === 'btn-rail-menu' && !c[1] && sl === 'search-input', JSON.stringify({ geo, o, c, sl }));
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
    // Compact: a station opens the bottom sheet (peek), the grip takes it to
    // full (modal: <main> inert), the lightbox still works from it, and Esc
    // closes it and drops ?station=.
    {
      const { page, close } = await open('?station=aceashla&lng=-106.14&lat=45.57&zoom=9', { ready: dataReady, viewport: { name: '390', width: 390, height: 844, touch: true } });
      const peek = await page.waitForSelector('#station-sheet[data-state="peek"]', { timeout: 15000 }).then(() => true, () => false);
      const noPopup = await page.locator('.maplibregl-popup').count() === 0;
      const title = await page.evaluate(() => [document.getElementById('station-sheet-title').textContent, document.activeElement?.id]);
      check('compact deep link opens the sheet at peek (no anchored popup), focus on its title', peek && noPopup && title[0] === 'Ashland' && title[1] === 'station-sheet-title', JSON.stringify({ peek, noPopup, title }));
      await page.locator('#station-sheet .mco-sheet-grip').focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
      const full = await page.evaluate(() => ({ st: document.getElementById('station-sheet').dataset.state, inert: document.getElementById('main').inert }));
      check('grip Enter -> full detent, <main> inert', full.st === 'full' && full.inert, JSON.stringify(full));
      await page.locator('#station-sheet .visit-photo-thumb').first().click();
      const lb = await page.waitForFunction(() => document.getElementById('lightbox').open && document.getElementById('lightbox-img').naturalWidth > 0, null, { timeout: 15000 }).then(() => true, () => false);
      // Usable over the modal sheet: not inert, and Next steps the gallery.
      const cap0 = await page.textContent('#lightbox-caption');
      await page.click('#lightbox-next');
      await page.waitForTimeout(300);
      const lbUse = await page.evaluate((c0) => ({ inert: document.getElementById('lightbox').inert || !!document.getElementById('lightbox').closest('[inert]'), stepped: document.getElementById('lightbox-caption').textContent !== c0 }), cap0);
      check('lightbox over the full sheet is live (not inert) and Next steps the gallery', !lbUse.inert && lbUse.stepped, JSON.stringify(lbUse));
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      const after1 = await page.evaluate(() => ({ lb: document.getElementById('lightbox').open, st: document.getElementById('station-sheet').dataset.state }));
      check('lightbox opens from the full sheet; its Esc closes only the lightbox', lb && !after1.lb && after1.st === 'full', JSON.stringify({ lb, ...after1 }));
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      const after = await page.evaluate(() => ({ st: document.getElementById('station-sheet').dataset.state, q: location.search, inert: document.getElementById('main').inert }));
      check('Esc closes the sheet, un-inerts <main>, drops ?station=', after.st === 'closed' && !after.inert && !/station=/.test(after.q), JSON.stringify(after));
      await close();
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
    // Kit 0.21.0 conformance. ?station= (no camera) opens the sheet at 1440
    // (end-docked) and at 390 (bottom sheet), never an anchored popup. Once
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

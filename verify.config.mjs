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
   counts canvas pixels in the overdue/visited colors. A CSP-blocked MapLibre
   worker leaves the basemap up with nothing on it, and only that probe sees
   it. The "photos load" probe counts responses from the AirTable attachment
   host after opening a station with photos — a blocked CSS background-image
   is an empty box, not a console error. */
import { load } from '../mco-web-style/tools/verify/lib.mjs';

const dataReady = () => document.querySelectorAll('#sr-station-rows tr').length > 100;

// Compliance-mode dot colors (app.js MODES): visited and overdue.
const DOT_RGB = [[0x2a, 0x8a, 0x86], [0xb8, 0x42, 0x1b]];

async function dotPixels(page) {
  const { PNG } = await load('pngjs');
  const box = await page.locator('#map').boundingBox();
  const png = PNG.sync.read(await page.screenshot({ clip: box }));
  let n = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    if (DOT_RGB.some(([R, G, B]) => Math.abs(r - R) + Math.abs(g - G) + Math.abs(b - B) < 24)) n++;
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
    // A station popup open (visit history, pills, photos, links): it only
    // exists after a click, so a load-only scan never audits it.
    { name: 'station-popup', query: '?station=aceashla&lng=-106.41&lat=45.6&zoom=9', ready: () => !!document.querySelector('.maplibregl-popup .visit-photo-thumb') },
  ],
  exemptTargets: '',
  allowProblems: [],
  dialogOpener: '#btn-info',
  shortcuts: [{ key: '/', effect: () => document.activeElement?.id === 'search-input' }],
  probes: async ({ open, check }) => {
    // The map draws its data, not just the basemap.
    {
      const { page, close, problems } = await open('', { ready: dataReady, settleMs: 2500 });
      const n = await dotPixels(page);
      check(`station dots paint on the canvas (${n} px in data colors)`, n > 300, String(n));
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
        rows: document.querySelectorAll('#sr-station-rows tr').length,
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
      const opened = await page.waitForFunction(() => /Ashland/.test(document.querySelector('.maplibregl-popup')?.textContent || ''), null, { timeout: 15000 }).then(() => true, () => false);
      check(`search lists matches (${opts}) and Enter opens that station`, opts > 0 && opened);
      await close();
    }
    // Deep link opens the popup, and its visit photos actually load.
    {
      const { page, close, problems } = await open('?station=aceashla&lng=-106.41&lat=45.6&zoom=9', { ready: dataReady, settleMs: 500 });
      await page.waitForSelector('.maplibregl-popup .visit-photo-thumb', { timeout: 15000 }).catch(() => {});
      const thumbs = await page.locator('.maplibregl-popup .visit-photo-thumb').count();
      check(`?station= deep link opens a popup with photo thumbs (${thumbs})`, thumbs > 0);
      // Background images start loading as the thumbs render; give them time.
      // Resource Timing lists every fetched image, CSS backgrounds included; a
      // CSP-blocked one never gets an entry (and shows up in problems()).
      const photosLoaded = () => page.evaluate(() => performance.getEntriesByType('resource')
        .filter((e) => /airtableusercontent\.com/.test(e.name) && e.responseEnd > 0).length);
      let photos = 0;
      for (let i = 0; i < 40 && !(photos = await photosLoaded()); i++) await page.waitForTimeout(250);
      // Reading the computed style proves the url() survived intact.
      const bg = await page.locator('.maplibregl-popup .visit-photo-thumb').first()
        .evaluate((el) => getComputedStyle(el).backgroundImage).catch(() => '');
      check(`visit photos load from *.airtableusercontent.com (${photos} responses)`, photos > 0 && /airtableusercontent/.test(bg), bg.slice(0, 80));
      await page.locator('.maplibregl-popup .visit-photo-thumb').first().click();
      const lb = await page.waitForFunction(() => {
        const i = document.getElementById('lightbox-img');
        return document.getElementById('lightbox').open && i.complete && i.naturalWidth > 0;
      }, null, { timeout: 15000 }).then(() => true, () => false);
      check('thumb opens the lightbox and the full photo loads', lb);
      check('?station= re-emits in the URL', /station=aceashla/.test(await page.evaluate(() => location.search)));
      const probs = await problems();
      check('no console / CSP problems with a popup + lightbox open', probs.length === 0, probs.slice(0, 3).join(' | '));
      await close();
    }
  },
};

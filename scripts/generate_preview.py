#!/usr/bin/env python3
"""
Generate assets/og-card.png by screenshotting the live site (HydroMet only,
labels on, light theme) at 2400x1260 (an 1800x945 viewport at 4/3x).

The resulting image is committed to assets/ and used as the og:image /
twitter:image social preview (see the meta tags in index.html).

Usage:
    pip install playwright
    playwright install --with-deps chromium
    python scripts/generate_preview.py
"""

import re
from pathlib import Path

from playwright.sync_api import sync_playwright

OUT = Path(__file__).parent.parent / "assets" / "og-card.png"
# The canonical URL. HydroMet only (AgriMet carries no visit requirement, so
# its dots are noise on the card), station-ID labels on, light theme.
URL = "https://mesonet.climate.umt.edu/maintenance/"
QUERY = "net=hydromet&labels=on&theme=light"
# CSS viewport at the 1.91:1 og:image shape, rendered at 4/3x so the PNG is
# 2400x1260 — keep og:image:width/height in index.html in step. The viewport
# is that wide on purpose: the map fits Montana at ~z6.2 here, and station-ID
# labels (labels=on) only draw at LABEL_MINZOOM = 6 in app.js. At 1200 CSS px
# the fit is ~z5.6 and the labels silently vanish.
WIDTH, HEIGHT = 1800, 945
SCALE = 4 / 3


def main() -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(
            viewport={"width": WIDTH, "height": HEIGHT},
            device_scale_factor=SCALE,
            color_scheme="light",  # match the forced ?theme=light
            timezone_id="America/Denver",
        )
        # Suppress the first-visit help dialog, which would otherwise cover
        # the map (app.js: 'mco-maint-seen-intro').
        ctx.add_init_script(
            "try { localStorage.setItem('mco-maint-seen-intro', '1'); } catch (e) {}"
        )
        page = ctx.new_page()

        # Surface any JS errors or console warnings to stdout for debugging.
        page.on("console", lambda msg: print(f"  [{msg.type}] {msg.text}") if msg.type != "log" else None)
        page.on("pageerror", lambda err: print(f"  [pageerror] {err}"))

        print(f"Loading {URL}?{QUERY}…")
        page.goto(f"{URL}?{QUERY}", wait_until="networkidle", timeout=60_000)

        # loadAll() stamps "loaded HH:MM MT" only after both API reads have
        # landed and the station layer is built; the banner means the
        # maintenance feed failed, and a card of grey dots is worse than
        # yesterday's card.
        # A locator, not wait_for_function: a string predicate is eval'd
        # in-page and the CSP has no 'unsafe-eval'.
        page.locator("#refresh-stamp", has_text=re.compile(r"^loaded")).wait_for(timeout=60_000)
        if page.locator("#data-banner").is_visible():
            raise RuntimeError("Maintenance feed unavailable; not overwriting the card.")

        # Let basemap/hillshade tiles requested by the data render finish.
        page.wait_for_load_state("networkidle", timeout=60_000)
        page.wait_for_timeout(2_000)

        page.screenshot(path=str(OUT))
        print(f"Preview saved → {OUT}")

        browser.close()


if __name__ == "__main__":
    main()

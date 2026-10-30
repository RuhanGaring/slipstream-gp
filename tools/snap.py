"""Screenshot a local HTML file. usage: python tools/snap.py IN.html OUT.png [W H]"""
import sys, pathlib
from playwright.sync_api import sync_playwright
src, dst = sys.argv[1], sys.argv[2]
W = int(sys.argv[3]) if len(sys.argv) > 3 else 1560
H = int(sys.argv[4]) if len(sys.argv) > 4 else 1720
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": W, "height": H})
    pg.goto(pathlib.Path(src).resolve().as_uri())
    pg.screenshot(path=dst, full_page=True)
    b.close()

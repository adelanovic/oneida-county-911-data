"""Assemble the map page from geo/map_template.html, Leaflet CSS and geo/map_data.json.

Writes docs/index.html (served by GitHub Pages) and output/map/oneida_911_map.html (local copy).
Usage: python -I geo/make_map_page.py geo/vendor/leaflet-1.9.4.css
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKELETON = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="Where Oneida County, NY 911 dispatches happened in 2024-2026, filterable by call type, town, responder and year.">
<style>body { margin: 0; } [hidden] { display: none !important; }</style>
"""

leaflet_css = Path(sys.argv[1]).read_text(encoding="utf-8")
leaflet_js = (ROOT / "geo" / "vendor" / "leaflet-1.9.4.js").read_text(encoding="utf-8")
data = (ROOT / "geo" / "map_data.json").read_text(encoding="utf-8").replace("</", r"<\/")
page = (ROOT / "geo" / "map_template.html").read_text(encoding="utf-8")
page = SKELETON + page.replace("__LEAFLET_CSS__", leaflet_css).replace("__LEAFLET_JS__", leaflet_js).replace("__DATA__", data) + "\n</html>\n"

docs = ROOT / "docs"
docs.mkdir(exist_ok=True)
(docs / ".nojekyll").touch()  # serve files as-is, skip GitHub's Jekyll processing
for out in (docs / "index.html", ROOT / "output" / "map" / "oneida_911_map.html"):
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page, encoding="utf-8")
    print(out, f"{out.stat().st_size / 1e6:.2f} MB")

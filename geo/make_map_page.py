"""Assemble output/map/oneida_911_map.html from geo/map_template.html, Leaflet CSS and geo/map_data.json."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
leaflet_css = Path(sys.argv[1]).read_text(encoding="utf-8")
data = (ROOT / "geo" / "map_data.json").read_text(encoding="utf-8").replace("</", r"<\/")
page = (ROOT / "geo" / "map_template.html").read_text(encoding="utf-8")
page = page.replace("__LEAFLET_CSS__", leaflet_css).replace("__DATA__", data)
out = ROOT / "output" / "map" / "oneida_911_map.html"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(page, encoding="utf-8")
print(out, f"{out.stat().st_size / 1e6:.2f} MB")

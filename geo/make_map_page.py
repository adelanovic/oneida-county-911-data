"""Build the hosted map with compressed assets and a standalone offline copy.

Usage: python -I geo/make_map_page.py geo/vendor/leaflet-1.9.4.css
"""
import base64
import gzip
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKELETON = '''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="Where Oneida County, NY 911 dispatches happened in 2024-2026, filterable by call type, town, responder and year.">
<style>body { margin: 0; } [hidden] { display: none !important; }</style>
'''
WIDTHS = {"t": 2, "a": 1, "c": 1, "d": 2, "h": 1, "l": 2, "u": 1, "m": 1,
          "i": 4, "k": 2, "s": 2, "z": 4, "q": 1, "p": 1, "f": 2, "v": 2, "r": 2}


def encode_records(data):
    """One aligned little-endian buffer, retaining every source record exactly."""
    if set(data["records"]) != set(WIDTHS):
        raise ValueError("Record schema changed; update the binary writer and loader together")
    binary = bytearray()
    layout = {}
    for key, width in WIDTHS.items():
        binary.extend(b"\0" * (-len(binary) % 4))
        column = base64.b64decode(data["records"][key], validate=True)
        if len(column) != data["total"] * width:
            raise ValueError(f"Invalid record count for column {key}")
        layout[key] = {"offset": len(binary), "width": width, "count": data["total"]}
        binary.extend(column)
    return bytes(binary), layout


def main():
    leaflet_css = Path(sys.argv[1]).read_text(encoding="utf-8")
    leaflet_js = (ROOT / "geo/vendor/leaflet-1.9.4.js").read_text(encoding="utf-8")
    loader = (ROOT / "geo/data_loader.js").read_text(encoding="utf-8")
    data = json.loads((ROOT / "geo/map_data.json").read_text(encoding="utf-8"))
    template = (ROOT / "geo/map_template.html").read_text(encoding="utf-8")
    template = template.replace("__LEAFLET_CSS__", leaflet_css).replace("__LEAFLET_JS__", leaflet_js).replace("__DATA_LOADER__", loader)
    assets = ROOT / "docs/assets"
    assets.mkdir(parents=True, exist_ok=True)
    (ROOT / "docs/.nojekyll").touch()

    def asset(stem, payload):
        compressed = gzip.compress(payload, compresslevel=9, mtime=0)
        name = f"{stem}-{hashlib.sha256(compressed).hexdigest()[:16]}.gz"
        (assets / name).write_bytes(compressed)
        print(f"assets/{name}: {len(compressed) / 1e6:.2f} MB")
        return "assets/" + name

    binary, layout = encode_records(data)
    metadata = dict(data, records=layout, recordBytes=len(binary), formatVersion=1)
    bootstrap = {"formatVersion": 1,
                 "metadataUrl": asset("metadata.json", json.dumps(metadata, separators=(",", ":")).encode("utf-8")),
                 "recordsUrl": asset("records.bin", binary)}

    for path, payload in [(ROOT / "docs/index.html", bootstrap),
                          (ROOT / "output/map/oneida_911_map.html", data)]:
        embedded = json.dumps(payload, separators=(",", ":")).replace("</", r"<\/")
        page = SKELETON + template.replace("__DATA__", embedded) + "\n</html>\n"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(page, encoding="utf-8")
        print(f"{path}: {path.stat().st_size / 1e6:.2f} MB")


if __name__ == "__main__":
    main()

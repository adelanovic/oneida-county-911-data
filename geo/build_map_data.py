"""Aggregate geocoded records + a simplified TIGER basemap into geo/map_data.json for the map page."""
import json
from pathlib import Path

import math

import pandas as pd
import shapefile
from shapely.geometry import shape, mapping
from shapely.ops import linemerge, unary_union

ROOT = Path(__file__).resolve().parent.parent
TIGER = ROOT / "geo" / "tiger"


def load(path):
    r = shapefile.Reader(str(path))
    return [(rec.record.as_dict(), shape(rec.shape.__geo_interface__)) for rec in r.iterShapeRecords()]


def coords(geom, tol):
    """Simplified geometry as nested [lat, lon] lists rounded to ~10 m (Leaflet order)."""
    g = geom.simplify(tol, preserve_topology=True)
    m = mapping(g)

    def ring(cs):
        return [[round(y, 4), round(x, 4)] for x, y in cs]

    t = m["type"]
    if t == "Polygon":
        return [[ring(r) for r in m["coordinates"]]]
    if t == "MultiPolygon":
        return [[ring(r) for r in p] for p in m["coordinates"]]
    if t == "LineString":
        return [ring(m["coordinates"])]
    if t == "MultiLineString":
        return [ring(l) for l in m["coordinates"]]
    return []


ROAD_CLASSES = {  # TIGER MTFCC -> drawing class
    "S1100": "highway", "S1630": "highway", "S1200": "primary",
    "S1400": "local", "S1640": "minor", "S1730": "minor", "S1740": "minor",
}


def delta_lines(geom, tol):
    """Lines as delta-encoded integer [lat, lon] pairs at 1e-5 degree (~1 m) resolution."""
    g = geom.simplify(tol, preserve_topology=False)
    parts = [g] if g.geom_type == "LineString" else list(getattr(g, "geoms", []))
    out = []
    for part in parts:
        flat, plat, plon = [], 0, 0
        for x, y in part.coords:
            la, lo = round(y * 1e5), round(x * 1e5)
            flat += [la - plat, lo - plon]
            plat, plon = la, lo
        if len(flat) >= 4:
            out.append(flat)
    return out


def street_labels(roads):
    """Label anchors along named streets: one per ~800 m of road, with the road's angle at that spot."""
    by_name = {}
    for r, g in roads:
        if r["FULLNAME"] and ROAD_CLASSES.get(r["MTFCC"]) in ("highway", "primary", "local"):
            by_name.setdefault(r["FULLNAME"], []).append(g)
    names, anchors = [], []
    for name, geoms in by_name.items():
        u = unary_union(geoms)
        merged = linemerge(u) if u.geom_type == "MultiLineString" else u
        pieces = [merged] if merged.geom_type == "LineString" else list(merged.geoms)
        idx = len(names)
        names.append(name)
        for line in pieces:
            if line.length < 0.0015:
                continue
            n = max(1, int(line.length / 0.008))
            for k in range(n):
                d = line.length * (k + 0.5) / n
                p, q = line.interpolate(max(d - 0.0002, 0)), line.interpolate(min(d + 0.0002, line.length))
                dx = (q.x - p.x) * math.cos(math.radians(p.y))
                dy = q.y - p.y
                ang = -math.degrees(math.atan2(dy, dx))
                ang = ang - 180 if ang > 90 else ang + 180 if ang < -90 else ang
                m = line.interpolate(d)
                anchors.append([round(m.y, 5), round(m.x, 5), round(ang), idx])
    return names, anchors


def main():
    df = pd.read_csv(ROOT / "output" / "oneida_911_records.csv", keep_default_na=False, low_memory=False,
                     usecols=["street", "city", "response_type", "category", "year", "agency_type", "town", "village", "county"])
    loc = pd.read_csv(ROOT / "geo" / "locations.csv", keep_default_na=False)
    loc = loc[loc.precision != "none"].reset_index(drop=True)
    loc[["latitude", "longitude"]] = loc[["latitude", "longitude"]].astype(float)
    loc["loc_id"] = loc.index
    df = df.merge(loc[["street", "city", "loc_id"]], on=["street", "city"], how="left")

    types = (df.groupby(["response_type", "category"]).size().rename("n").reset_index()
             .sort_values("n", ascending=False).reset_index(drop=True))
    type_id = {t: i for i, t in enumerate(types.response_type)}
    years = sorted(df.year.unique().tolist())
    agency_types = df.agency_type.value_counts().index.tolist()

    df["t"] = df.response_type.map(type_id)
    df["y"] = df.year.map({y: i for i, y in enumerate(years)})
    df["a"] = df.agency_type.map({a: i for i, a in enumerate(agency_types)})
    located = df[df.loc_id.notna()].copy()
    located["loc_id"] = located.loc_id.astype(int)
    counts = located.groupby(["loc_id", "t", "y", "a"]).size().rename("n").reset_index()
    cities = df.city.value_counts().index.tolist()
    df["c"] = df.city.map({c: i for i, c in enumerate(cities)})
    unlocated = df[df.loc_id.isna()].groupby(["t", "y", "a", "c"]).size().rename("n").reset_index()

    # Basemap
    cousub = [(r, g) for r, g in load(TIGER / "tl_2024_36_cousub" / "tl_2024_36_cousub") if r["COUNTYFP"] == "065"]
    roads = load(TIGER / "tl_2024_36065_roads" / "tl_2024_36065_roads")
    water = load(TIGER / "tl_2024_36065_areawater" / "tl_2024_36065_areawater")
    basemap = {
        "towns": [{"name": r["NAMELSAD"], "rings": coords(g, 0.0008),
                   "label": [round(g.representative_point().y, 4), round(g.representative_point().x, 4)]}
                  for r, g in cousub],
        "roads": {cls: [l for r, g in roads if ROAD_CLASSES.get(r["MTFCC"]) == cls
                        for l in delta_lines(g, 0.00004 if cls in ("local", "minor") else 0.00008)]
                  for cls in ("minor", "local", "primary", "highway")},
        "water": [coords(g, 0.0006) for r, g in water if r["AWATER"] > 400_000],
    }

    label_names, label_anchors = street_labels(roads)
    basemap["labelNames"] = label_names
    basemap["labels"] = label_anchors

    data = {
        "types": [[r.response_type, r.category] for r in types.itertuples()],
        "years": years,
        "agencyTypes": agency_types,
        "locations": [[round(r.latitude, 5), round(r.longitude, 5), r.street, r.city, r.precision,
                       int(float(r.expected_error_m)) if r.expected_error_m != "" else None, r.match_method,
                       r.matched_name]
                      for r in loc.itertuples()],
        "counts": counts[["loc_id", "t", "y", "a", "n"]].values.tolist(),
        "unlocated": unlocated[["t", "y", "a", "c", "n"]].values.tolist(),
        "cities": cities,
        "cityInfo": {c: list(v) for c, v in df.groupby("city")[["town", "village", "county"]].first().iterrows()},
        "total": int(len(df)),
        "basemap": basemap,
    }
    out = ROOT / "geo" / "map_data.json"
    out.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    print(f"{out} {out.stat().st_size / 1e6:.2f} MB; locations {len(loc)}, count rows {len(counts)}, "
          f"types {len(types)}, towns {len(cousub)}, roads {sum(len(v) for v in basemap['roads'].values())}, labels {len(label_anchors)}, water {len(basemap['water'])}")


if __name__ == "__main__":
    main()

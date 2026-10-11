"""Pack geocoded dispatch records + a simplified TIGER basemap into geo/map_data.json for the map page."""
import base64
import json
import math
import re
from pathlib import Path

import numpy as np
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


def pack(values, dtype):
    """Little-endian typed array as base64, decoded in the page with Uint8Array/Uint16Array."""
    arr = np.asarray(values, dtype=dtype)
    assert (arr.astype(np.int64) == np.asarray(values, dtype=np.int64)).all(), "value out of range for " + str(dtype)
    return base64.b64encode(arr.astype(arr.dtype.newbyteorder("<")).tobytes()).decode("ascii")


def place_population(df):
    """Population (Census 2024 estimates) for each place key the page uses: "T:<TOWN>" and "V:<TOWN>|<VILLAGE>".

    Towns include their villages, except where the dispatch data files a village (or Sherrill) under a different
    town; split villages (New York Mills) use the part inside each town.
    """
    path = ROOT / "geo" / "census" / "sub-est.csv"
    if not path.exists():
        print("no geo/census/sub-est.csv; rates per resident will be unavailable")
        return {}
    est = pd.read_csv(path, dtype=str, encoding="latin-1")
    est = est[(est.STATE == "36") & (est.COUNTY == "065")]
    col = [c for c in est.columns if c.startswith("POPESTIMATE")][-1]
    est[col] = est[col].astype(int)
    strip = lambda n: re.sub(r" (town|city|village)( \(pt\.\))?$", "", n).upper()
    cousub = {r.COUSUB: (strip(r.NAME), r[col]) for _, r in est[est.SUMLEV == "061"].iterrows()}
    full = {strip(r.NAME): r[col] for _, r in est[est.SUMLEV == "157"].iterrows()}
    parts = [(r.COUSUB, strip(r.NAME), r[col]) for _, r in est[est.SUMLEV == "071"].iterrows()
             if not r.NAME.startswith("Balance") and r.PLACE != r.COUSUB]
    pairs = df[(df.county == "ONEIDA") & (df.town != "")][["town", "village"]].drop_duplicates()
    towns_of = pairs[pairs.village != ""].groupby("village").town.agg(set).to_dict()
    pop = {f"T:{name}": n for name, n in cousub.values()}
    for code, comp, n in parts:
        home = cousub[code][0]
        if comp == "SHERRILL":
            dest = "SHERRILL"
        elif comp in towns_of:
            dest = home if home in towns_of[comp] else next(iter(towns_of[comp]))
        else:
            dest = home
        if dest != home:
            pop[f"T:{home}"] -= n
            pop[f"T:{dest}"] = pop.get(f"T:{dest}", 0) + n
    for village, towns in towns_of.items():
        for town in towns:
            if len(towns) > 1:
                n = next((n for code, comp, n in parts if comp == village and cousub[code][0] == town), None)
            else:
                n = full.get(village)
            if n:
                pop[f"V:{town}|{village}"] = int(n)
    used = {f"T:{t}" for t in pairs.town} | {f"V:{t}|{v}" for t, v in pairs.itertuples(index=False) if v}
    out = {k: int(v) for k, v in pop.items() if k in used}
    out["ALL"] = int(est[est.SUMLEV == "050"][col].iloc[0])  # Oneida County
    return out


def main():
    df = pd.read_csv(ROOT / "output" / "oneida_911_records.csv", keep_default_na=False, low_memory=False,
                     usecols=["street", "city", "response_type", "category", "year", "agency_type", "town", "village",
                              "county", "call_datetime", "hour", "agency", "mpds_level", "incident_cluster_id"])
    loc = pd.read_csv(ROOT / "geo" / "locations.csv", keep_default_na=False)
    loc = loc[loc.precision != "none"].reset_index(drop=True)
    loc[["latitude", "longitude"]] = loc[["latitude", "longitude"]].astype(float)
    loc["loc_id"] = loc.index
    df = df.merge(loc[["street", "city", "loc_id"]], on=["street", "city"], how="left")

    types = (df.groupby(["response_type", "category"]).size().rename("n").reset_index()
             .sort_values("n", ascending=False).reset_index(drop=True))
    type_id = {t: i for i, t in enumerate(types.response_type)}
    years = sorted(df.year.unique().tolist())
    # Days with a report in each year; coverage is uneven (2025 and 2026 are a handful of days).
    days = df.assign(d=df.call_datetime.str[:10]).groupby("year").d.nunique()
    agency_types = df.agency_type.value_counts().index.tolist()

    cities = df.city.value_counts().index.tolist()
    agencies = df.agency.value_counts().index.tolist()
    levels = ["", "O", "A", "B", "C", "D", "E"]  # medical priority, lowest -> highest
    cluster_n = df.groupby("incident_cluster_id").incident_cluster_id.transform("size").clip(upper=255)
    dates = sorted(df.call_datetime.str[:10].unique().tolist())
    # One packed row per dispatch (column arrays, base64): call type, responder, reported city, date, hour, place.
    records = {
        "t": pack(df.response_type.map(type_id), np.uint16),
        "a": pack(df.agency_type.map({a: i for i, a in enumerate(agency_types)}), np.uint8),
        "c": pack(df.city.map({c: i for i, c in enumerate(cities)}), np.uint8),
        "d": pack(df.call_datetime.str[:10].map({d: i for i, d in enumerate(dates)}), np.uint16),
        "h": pack(df.hour.astype(int), np.uint8),
        "l": pack(df.loc_id.fillna(-1).astype(int) + 1, np.uint16),  # 0 = no location
        "u": pack(df.agency.map({a: i for i, a in enumerate(agencies)}), np.uint8),
        "m": pack(df.mpds_level.map({v: i for i, v in enumerate(levels)}), np.uint8),
        "k": pack(cluster_n, np.uint8),  # dispatches in the same incident group (heuristic)
    }

    # Basemap
    cousub = [(r, g) for r, g in load(TIGER / "tl_2024_36_cousub" / "tl_2024_36_cousub") if r["COUNTYFP"] == "065"]
    county = unary_union([g for r, g in cousub]).buffer(-0.002)
    roads = load(TIGER / "tl_2024_36065_roads" / "tl_2024_36065_roads")
    water = load(TIGER / "tl_2024_36065_areawater" / "tl_2024_36065_areawater")
    basemap = {
        "towns": [{"name": r["NAMELSAD"], "key": r["NAME"].upper(), "rings": coords(g, 0.0008),
                   "label": [round(g.representative_point().y, 4), round(g.representative_point().x, 4)]}
                  for r, g in cousub],
        "roads": {cls: [l for r, g in roads if ROAD_CLASSES.get(r["MTFCC"]) == cls
                        for l in delta_lines(g, 0.00004 if cls in ("local", "minor") else 0.00008)]
                  for cls in ("minor", "local", "primary", "highway")},
        "water": [coords(g, 0.0006) for r, g in water if r["AWATER"] > 400_000],
        # Villages and cities, for outlining the selected place.
        "places": [{"key": r["NAME"].upper(), "kind": r["NAMELSAD"].rsplit(" ", 1)[-1], "rings": coords(g, 0.0003)}
                   for r, g in load(TIGER / "tl_2024_36_place" / "tl_2024_36_place")
                   if r["NAMELSAD"].endswith((" village", " city")) and g.intersects(county)],
    }

    label_names, label_anchors = street_labels(roads)
    basemap["labelNames"] = label_names
    basemap["labels"] = label_anchors

    data = {
        "types": [[r.response_type, r.category] for r in types.itertuples()],
        "years": years,
        "yearDays": [int(days[y]) for y in years],
        "agencyTypes": agency_types,
        "locations": [[round(r.latitude, 5), round(r.longitude, 5), r.street, r.city, r.precision,
                       int(float(r.expected_error_m)) if r.expected_error_m != "" else None, r.match_method,
                       r.matched_name]
                      for r in loc.itertuples()],
        "dates": dates,
        "agencies": agencies,
        "agencyKind": [df.loc[df.agency == a, "agency_type"].iloc[0] for a in agencies],
        "population": place_population(df),
        "records": records,
        "cities": cities,
        "cityInfo": {c: list(v) for c, v in df.groupby("city")[["town", "village", "county"]].first().iterrows()},
        "total": int(len(df)),
        "basemap": basemap,
    }
    out = ROOT / "geo" / "map_data.json"
    out.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    print(f"{out} {out.stat().st_size / 1e6:.2f} MB; locations {len(loc)}, records {len(df)}, "
          f"types {len(types)}, towns {len(cousub)}, roads {sum(len(v) for v in basemap['roads'].values())}, labels {len(label_anchors)}, water {len(basemap['water'])}")


if __name__ == "__main__":
    main()

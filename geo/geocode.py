"""Geocode each (street, city) in output/oneida_911_records.csv using Census TIGER/Line 2024 data.

The reports name a street (no house number) and a city/town/village. Each pair is resolved to the stretch of
that street inside the municipality, then reduced to one point:

  1. Name matching: TIGER primary names plus every alternate name (FEATNAMES, e.g. "Genesee St" = "State Rte 12"),
     ordinal spelling ("SECOND ST" -> "2ND ST"), then fuzzy matching against roads that cross the municipality.
  2. Point choice: the address-weighted medoid of the street stretch — the point on the street that minimizes
     the expected distance to where the street's addresses are (TIGER ADDRFEAT house-number ranges). Rural
     stretches with no addresses pull the point less than built-up blocks. Falls back to the length-weighted
     medoid when the street has no address ranges.
  3. Named places that are not streets (apartment complexes, plazas, hospitals) are matched to TIGER point and
     area landmarks inside the municipality.
  4. Otherwise the municipality's center.

Outputs geo/locations.csv: one row per (street, city) with the point, how it was found, and how uncertain it is:
  precision        coordinates | intersection | street | street_nearby | landmark | municipality | none
  match_method     exact | alias | ordinal | spelling | fuzzy | fuzzy_risky | landmark | municipality | ...
  matched_name     the TIGER name used
  street_length_m  length of the matched stretch inside the municipality
  expected_error_m address-weighted mean distance from the point to the stretch (typical placement error if calls
                   happen where addresses are); for municipality fallbacks, the same measured over the municipality
  max_error_m      farthest point of the stretch from the chosen point
  n_pieces         disconnected pieces of the stretch (>1 means the name covers separate roads)
"""
import difflib
import math
import re
from collections import defaultdict
from pathlib import Path

import numpy as np
import pandas as pd
import shapefile
from shapely import affinity
from shapely.geometry import shape, Point, MultiLineString
from shapely.ops import unary_union, linemerge

ROOT = Path(__file__).resolve().parent.parent
TIGER = ROOT / "geo" / "tiger"

# Local equirectangular projection (meters) — error well under 1% across one county.
LAT0 = 43.2
KX, KY = 111_320 * math.cos(math.radians(LAT0)), 110_950


def to_m(g):
    return affinity.scale(g, xfact=KX, yfact=KY, origin=(0, 0))


def to_deg(p):
    return p.y / KY, p.x / KX


ORDINALS = {"FIRST": "1ST", "SECOND": "2ND", "THIRD": "3RD", "FOURTH": "4TH", "FIFTH": "5TH", "SIXTH": "6TH",
            "SEVENTH": "7TH", "EIGHTH": "8TH", "NINTH": "9TH", "TENTH": "10TH"}
ORDINAL_RE = re.compile(r"\b(" + "|".join(ORDINALS) + r")\b")


def ordinal_suffix(n):
    return "TH" if 10 <= n % 100 <= 20 else {1: "ST", 2: "ND", 3: "RD"}.get(n % 10, "TH")


def norm_tiger(name):
    n = name.upper()
    n = re.sub(r"^(STATE RTE|STATE HWY|US HWY|US RTE|NY-|NYS RTE|CO RD|COUNTY RD|CO RTE)\s*", "ROUTE ", n)
    n = re.sub(r"^SAINT ", "ST ", n)
    return re.sub(r"\s+", " ", n).strip()


def norm_cad(street):
    s = street.upper().strip()
    # A few rows carry a house number ("114 CHURCH ST"); keep "6 ST" (6th Street) intact.
    m = re.match(r"^\d+\s+(.+)$", s)
    if m and m.group(1) not in SUFFIXES and not re.match(r"^(ST|ND|RD|TH)\b", m.group(1)):
        s = m.group(1)
    s = re.sub(r"\s+(EB|WB|NB|SB|RAMP|EXIT \d+\w* RAMP|EXIT \d+\w*|ACCESS RD)$", "", s)
    return re.sub(r"\s+(EB|WB|NB|SB|RAMP)$", "", s)


# Spelling-insensitive key: "ROME-ORISKANY RD" = "ROME ORISKANY RD", "MC QUADE" = "MCQUADE", "MNR" = "MANOR".
KEY_WORDS = {"MNR": "MANOR", "TERR": "TER", "TERRACE": "TER", "PK": "PARK", "CORS": "CORNERS", "CTR": "CENTER",
             "HTS": "HEIGHTS", "MT": "MOUNT", "FT": "FORT", "PKY": "PKWY", "PARKWAY": "PKWY", "EXT": "EXD",
             "LA": "LN", "CRT": "CT", "AV": "AVE", "BL": "BLVD", "TPK": "TPKE", "HWY": "HWY"}
SUFFIXES = {"ST", "RD", "AVE", "BLVD", "DR", "LN", "PL", "CT", "CIR", "TER", "WAY", "PKWY", "HWY", "TPKE", "PARK",
            "SQ", "TRL", "LOOP", "PLZ", "ROW", "XING", "EXD", "RUN", "PATH", "PT", "VW", "HL", "CV"}


def match_key(name):
    toks = re.sub(r"['.]", "", name.upper()).replace("-", " ").split()
    return "".join(KEY_WORDS.get(t, t) for t in toks)


def suffix_of(name):
    toks = re.sub(r"['.]", "", name.upper()).replace("-", " ").split()
    for t in reversed(toks):
        t = KEY_WORDS.get(t, t)
        if t in SUFFIXES:
            return t
    return ""


DIR_WORDS = {"N": "N", "S": "S", "E": "E", "W": "W", "NORTH": "N", "SOUTH": "S", "EAST": "E", "WEST": "W"}


def directions(name):
    return {DIR_WORDS[t] for t in name.upper().split() if t in DIR_WORDS}


LANDMARK_WORDS = {"APTS": "APARTMENTS", "APT": "APARTMENTS", "MNR": "MANOR", "CTR": "CENTER", "PLZ": "PLAZA",
                  "HOSP": "HOSPITAL", "HTS": "HEIGHTS", "VLG": "VILLAGE", "TWRS": "TOWERS", "CMNTY": "COMMUNITY",
                  "COLL": "COLLEGE", "UNIV": "UNIVERSITY", "SCH": "SCHOOL", "HS": "HIGH SCHOOL", "MT": "MOUNT",
                  "PK": "PARK", "SHOPPING": "SHOPPING"}


def norm_landmark(s):
    toks = re.sub(r"[^A-Z0-9 ]", " ", s.upper()).split()
    return " ".join(LANDMARK_WORDS.get(t, t) for t in toks)


def load(path):
    r = shapefile.Reader(str(path))
    return [(rec.record.as_dict(), shape(rec.shape.__geo_interface__)) for rec in r.iterShapeRecords()]


def municipality_lookup(cousub, place):
    towns = {r["NAME"].upper(): g for r, g in cousub if r["COUNTYFP"] == "065"}
    towns_all = {r["NAME"].upper(): g for r, g in cousub}
    places = {r["NAME"].upper(): g for r, g in place}
    nym = places.get("NEW YORK MILLS")
    special = {
        "ROME INSIDE": towns["ROME"], "ROME OUTSIDE": towns["ROME"], "ROME": towns["ROME"],
        "TRENTON HINCKLEY": towns["TRENTON"],
        "ONEIDA CITY INSIDE": places.get("ONEIDA"),
        "SHERRILL": places.get("SHERRILL"),
        # New York Mills village straddles two towns; the CAD code names the part.
        "NEW YORK MILLS NEW HARTFORD": nym.intersection(towns["NEW HARTFORD"]),
        "NEW YORK MILLS WHITESTOWN": nym.intersection(towns["WHITESTOWN"]),
        "CLEVELAND OSWEGO CO": places.get("CLEVELAND"),
        "CONSTANTIA OSWEGO COUNTY": towns_all.get("CONSTANTIA"),
        "POLAND VILLAGE HERKIMER CO": places.get("POLAND"),
        "PULASKI": places.get("PULASKI"),
        "OHIO": towns_all.get("OHIO"),
        "WEST LEYDEN": towns_all.get("LEYDEN"),
    }

    def poly(city):
        c = city.upper()
        if c in special:
            return special[c]
        if c.endswith(" VILLAGE"):
            return places.get(c[: -len(" VILLAGE")])
        return towns.get(c) or places.get(c)

    return poly


# ---------------------------------------------------------------------------------------------------------------
# Point choice on a (multi)line, in meters

def samples(geom_m, weights=None, step=25.0, cap=600):
    """Points spaced along the geometry with a weight per point (length share x address density)."""
    pts, ws = [], []
    parts = [geom_m] if geom_m.geom_type == "LineString" else list(getattr(geom_m, "geoms", []))
    total = sum(p.length for p in parts if p.geom_type == "LineString")
    if total == 0:
        return np.empty((0, 2)), np.empty(0)
    step = max(step, total / cap)
    for i, part in enumerate(parts):
        if part.geom_type != "LineString" or part.length == 0:
            continue
        n = max(1, int(part.length / step))
        dens = weights[i] if weights is not None else 1.0
        for k in range(n):
            q = part.interpolate((k + 0.5) / n, normalized=True)
            pts.append((q.x, q.y))
            ws.append(dens * part.length / n)
    return np.array(pts), np.array(ws)


def medoid(pts, ws):
    """Sample minimizing the weighted mean distance to all samples; returns (point, expected error, max error)."""
    if len(pts) == 1:
        return pts[0], 0.0, 0.0
    d = np.sqrt(((pts[:, None, :] - pts[None, :, :]) ** 2).sum(-1))
    cost = d @ ws
    i = int(cost.argmin())
    wsum = ws.sum()
    return pts[i], float(cost[i] / wsum) if wsum else 0.0, float(d[i][ws > 0].max()) if (ws > 0).any() else 0.0


def midpoint(geom_m):
    """The original method: middle of the longest connected piece."""
    merged = linemerge(geom_m) if geom_m.geom_type == "MultiLineString" else geom_m
    if merged.geom_type == "MultiLineString":
        merged = max(merged.geoms, key=lambda g: g.length)
    if merged.geom_type != "LineString":
        p = geom_m.representative_point()
        return np.array([p.x, p.y])
    p = merged.interpolate(0.5, normalized=True)
    return np.array([p.x, p.y])


def n_pieces(geom_m, gap=150.0):
    """Count clusters of pieces separated by more than `gap` meters."""
    parts = [geom_m] if geom_m.geom_type == "LineString" else list(getattr(geom_m, "geoms", []))
    clusters = []
    for p in parts:
        hit = [c for c in clusters if any(p.distance(q) <= gap for q in c)]
        merged = [p] + [q for c in hit for q in c]
        clusters = [c for c in clusters if c not in hit] + [merged]
    return len(clusters)


# ---------------------------------------------------------------------------------------------------------------

class Geocoder:
    BUF = 200.0  # meters of tolerance at municipal boundaries

    def __init__(self):
        roads = load(TIGER / "tl_2024_36065_roads" / "tl_2024_36065_roads")
        cousub = load(TIGER / "tl_2024_36_cousub" / "tl_2024_36_cousub")
        place = load(TIGER / "tl_2024_36_place" / "tl_2024_36_place")
        poly_deg = municipality_lookup(cousub, place)
        self._poly_cache = {}
        self.poly_deg = poly_deg
        county = unary_union([g for r, g in cousub if r["COUNTYFP"] == "065"])

        geom_by_lid = {r["LINEARID"]: to_m(g) for r, g in roads}
        # Every name (primary and alternate) a road carries, from FEATNAMES.
        names = defaultdict(set)   # norm name -> LINEARIDs
        primary = defaultdict(set)
        for r, g in roads:
            if r["FULLNAME"]:
                names[norm_tiger(r["FULLNAME"])].add(r["LINEARID"])
                primary[norm_tiger(r["FULLNAME"])].add(r["LINEARID"])
        fn = shapefile.Reader(str(TIGER / "tl_2024_36065_featnames" / "tl_2024_36065_featnames.dbf"))
        for rec in fn.iterRecords(fields=["FULLNAME", "LINEARID"]):
            if rec["FULLNAME"] and rec["LINEARID"] in geom_by_lid:
                names[norm_tiger(rec["FULLNAME"])].add(rec["LINEARID"])
        self.geom = {n: unary_union([geom_by_lid[l] for l in lids]) for n, lids in names.items()}
        self.is_primary = {n: n in primary for n in names}
        self.primary_len = {n: unary_union([geom_by_lid[l] for l in lids]).length for n, lids in primary.items()}
        self.by_key = defaultdict(list)
        for n in self.geom:
            self.by_key[match_key(n)].append(n)

        # Address counts per edge, grouped by street name, for weighting.
        self.addr = defaultdict(list)  # norm name -> [(geom_m, addresses)]
        for r, g in load(TIGER / "tl_2024_36065_addrfeat" / "tl_2024_36065_addrfeat"):
            if not r["FULLNAME"]:
                continue
            n = 0
            for a, b in ((r["LFROMHN"], r["LTOHN"]), (r["RFROMHN"], r["RTOHN"])):
                if a.isdigit() and b.isdigit():
                    n += abs(int(b) - int(a)) // 2 + 1
            self.addr[norm_tiger(r["FULLNAME"])].append((to_m(g), n))

        # Landmarks (points and areas) in and around the county.
        area = county.buffer(0.05)
        self.landmarks = []  # (normalized name, raw name, geom_m)
        for path in [TIGER / "tl_2024_36_pointlm" / "tl_2024_36_pointlm", TIGER / "tl_2024_36_arealm" / "tl_2024_36_arealm"]:
            for r, g in load(path):
                if r["FULLNAME"] and g.intersects(area):
                    self.landmarks.append((norm_landmark(r["FULLNAME"]), r["FULLNAME"], to_m(g)))
        self._cand = {}
        self._street = {}

    def poly(self, city):
        if city not in self._poly_cache:
            g = self.poly_deg(city) if city else None
            self._poly_cache[city] = to_m(g) if g is not None and not g.is_empty else None
        return self._poly_cache[city]

    def candidates(self, city):
        if city not in self._cand:
            area = self.poly(city).buffer(self.BUF)
            self._cand[city] = [n for n, g in self.geom.items() if g.intersects(area)]
        return self._cand[city]

    def resolve(self, name, city):
        if name in self.geom:
            return name, "exact" if self.is_primary[name] else "alias"
        alt = ORDINAL_RE.sub(lambda m: ORDINALS[m.group(1)], name)
        alt = re.sub(r"^(\d+) ST\b", lambda m: m.group(1) + ordinal_suffix(int(m.group(1))) + " ST", alt)
        if alt in self.geom:
            return alt, "ordinal"
        muni = self.poly(city)
        local = set(self.candidates(city)) if muni is not None else set()
        same_key = self.by_key.get(match_key(alt), [])
        if same_key:
            inside = [n for n in same_key if n in local] or same_key
            return inside[0], "spelling"
        if muni is not None:
            for cand in difflib.get_close_matches(name, list(local), n=3, cutoff=0.86):
                dc, dn = directions(cand), directions(name)
                if dc and dn and dc != dn:
                    continue  # "E LAKE ST" is not "W LAKE ST"; "HANGAR RD W" may still be "HANGAR RD"
                risky = suffix_of(cand) != suffix_of(name) or re.findall(r"\d+", cand) != re.findall(r"\d+", name)
                return cand, "fuzzy_risky" if risky else "fuzzy"
        return None, None

    def street(self, name, city):
        """-> dict(geom_m, matched_name, method, precision) or None"""
        key = (name, city)
        if key in self._street:
            return self._street[key]
        out = None
        matched, method = self.resolve(name, city)
        if matched:
            g, muni = self.geom[matched], self.poly(city)
            if muni is not None:
                clip = g.intersection(muni.buffer(self.BUF))
                if not clip.is_empty and clip.length > 0:
                    out = dict(geom=clip, matched=matched, method=method, precision="street", area=muni.buffer(self.BUF))
                elif g.distance(muni) < 3000:
                    out = dict(geom=g, matched=matched, method=method, precision="street_nearby", area=None)
            elif g.length < 20_000:
                out = dict(geom=g, matched=matched, method=method, precision="street_nearby", area=None)
        self._street[key] = out
        return out

    def place_on(self, hit, method="address"):
        """Choose a point on a matched street. method: address | uniform | midpoint."""
        g = hit["geom"]
        if method == "midpoint":
            p = midpoint(g)
            pts, ws = samples(g)
            d = np.sqrt(((pts - p) ** 2).sum(-1)) if len(pts) else np.zeros(1)
            return p, float((d * ws).sum() / ws.sum()) if len(pts) else 0.0, float(d.max())
        if method == "address":
            segs = self.addr.get(hit["matched"], [])
            if hit["area"] is not None:
                segs = [(s.intersection(hit["area"]), n) for s, n in segs if s.intersects(hit["area"])]
            segs = [(s, n) for s, n in segs if not s.is_empty and s.length > 0 and n > 0]
            if segs:
                geoms, dens = [], []
                for s, n in segs:
                    for part in ([s] if s.geom_type == "LineString" else list(s.geoms)):
                        if part.geom_type == "LineString" and part.length > 0:
                            geoms.append(part)
                            dens.append(n / s.length)
                # Address-less stretches still count a little (businesses, through traffic).
                floor = 0.1 * np.median(dens)
                rest = g.difference(unary_union(geoms).buffer(5))
                rest_parts = [rest] if rest.geom_type == "LineString" else [p for p in getattr(rest, "geoms", []) if p.geom_type == "LineString"]
                rest_parts = [p for p in rest_parts if not p.is_empty and p.length > 1]
                allg = geoms + rest_parts
                alld = dens + [floor] * len(rest_parts)
                pts, ws = samples(MultiLineString(allg), weights=alld)
                if len(pts):
                    return medoid(pts, ws)
        pts, ws = samples(g)
        return medoid(pts, ws)

    def municipality_point(self, city):
        muni = self.poly(city)
        p = muni.representative_point()
        # Expected error of a town-center guess: mean distance to points spread over the municipality.
        minx, miny, maxx, maxy = muni.bounds
        rng = np.random.default_rng(0)
        xs, ys = rng.uniform(minx, maxx, 4000), rng.uniform(miny, maxy, 4000)
        inside = [(x, y) for x, y in zip(xs, ys) if muni.contains(Point(x, y))][:800]
        d = [math.hypot(x - p.x, y - p.y) for x, y in inside] or [0.0]
        return np.array([p.x, p.y]), float(np.mean(d)), float(np.max(d))

    def landmark(self, name, city):
        muni = self.poly(city)
        if muni is None:
            return None
        area = muni.buffer(self.BUF)
        q = norm_landmark(name)
        qt = set(q.split())
        best = None
        for ln, raw, g in self.landmarks:
            if not g.intersects(area):
                continue
            lt = set(ln.split())
            score = difflib.SequenceMatcher(None, q, ln).ratio()
            if qt and qt <= lt:
                score = max(score, 0.9)
            if score >= 0.85 and (best is None or score > best[0]):
                best = (score, raw, g)
        return best


def main():
    gc = Geocoder()
    df = pd.read_csv(ROOT / "output" / "oneida_911_records.csv", keep_default_na=False, low_memory=False,
                     usecols=["street", "city", "latitude", "longitude"])
    locs = df.groupby(["street", "city"]).agg(n=("street", "size"), lat=("latitude", "first"),
                                              lon=("longitude", "first")).reset_index()
    rows = []
    for r in locs.itertuples():
        row = {"street": r.street, "city": r.city, "records": r.n, "latitude": None, "longitude": None,
               "precision": "none", "match_method": "", "matched_name": "", "street_length_m": None,
               "expected_error_m": None, "max_error_m": None, "n_pieces": None}
        muni = gc.poly(r.city) if r.city else None
        if r.lat != "" and r.lon != "":
            row.update(latitude=float(r.lat), longitude=float(r.lon), precision="coordinates",
                       match_method="reported", expected_error_m=0, max_error_m=0)
        elif r.street:
            parts = [norm_cad(p) for p in r.street.split(" / ")]
            if len(parts) == 2:
                a, b = gc.street(parts[0], r.city), gc.street(parts[1], r.city)
                if a and b:
                    x = a["geom"].intersection(b["geom"])
                    if not x.is_empty:
                        p = x if x.geom_type == "Point" else x.representative_point()
                        lat, lon = to_deg(p)
                        row.update(latitude=lat, longitude=lon, precision="intersection", match_method="intersection",
                                   matched_name=f"{a['matched']} / {b['matched']}", expected_error_m=0, max_error_m=0)
            if row["precision"] == "none":
                for part in parts:
                    hit = gc.street(part, r.city)
                    if hit:
                        p, err, mx = gc.place_on(hit)
                        lat, lon = to_deg(Point(p))
                        row.update(latitude=lat, longitude=lon, precision=hit["precision"], match_method=hit["method"],
                                   matched_name=hit["matched"], street_length_m=round(hit["geom"].length),
                                   expected_error_m=round(err), max_error_m=round(mx), n_pieces=n_pieces(hit["geom"]))
                        break
            if row["precision"] == "none" and muni is not None:
                lm = gc.landmark(r.street, r.city)
                if lm:
                    c = lm[2].centroid if lm[2].geom_type != "Point" else lm[2]
                    lat, lon = to_deg(c)
                    rad = math.sqrt(lm[2].area / math.pi) if lm[2].area else 0
                    row.update(latitude=lat, longitude=lon, precision="landmark", match_method="landmark",
                               matched_name=lm[1], expected_error_m=round(rad / 2), max_error_m=round(rad))
        if row["precision"] == "none" and muni is not None:
            p, err, mx = gc.municipality_point(r.city)
            lat, lon = to_deg(Point(p))
            row.update(latitude=lat, longitude=lon, precision="municipality", match_method="municipality",
                       expected_error_m=round(err), max_error_m=round(mx))
        rows.append(row)

    out = pd.DataFrame(rows)
    out.to_csv(ROOT / "geo" / "locations.csv", index=False)
    w = out.groupby("precision").records.sum()
    print("records by precision:\n" + (w / w.sum()).round(4).to_string())
    m = out[out.match_method != ""].groupby("match_method").records.sum()
    print("records by match method:\n" + m.to_string())


if __name__ == "__main__":
    main()

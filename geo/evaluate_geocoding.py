"""Compare point-placement methods using intersections inferred from reported street names.

A call logged at "A / B" happened where A crosses B. Taking that crossing as the true location of a call on
street A (and on street B), we ask each method to place "street A in this town" without knowing B, and measure
the distance to the crossing. These crossings use the same TIGER geometry as the geocoder; they are not
independent incident ground truth. Intersection calls are not a random sample of calls on a street (they sit at
corners, not mid-block), so read the numbers as a comparison between methods rather than an absolute error.

Also prints the fuzzy and landmark matches from geo/locations.csv for manual review.
"""
from pathlib import Path

import numpy as np
import pandas as pd
from shapely.geometry import Point

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from geocode import Geocoder, norm_cad  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def main():
    gc = Geocoder()
    df = pd.read_csv(ROOT / "output" / "oneida_911_records.csv", keep_default_na=False, low_memory=False,
                     usecols=["street", "city"])
    inter = df[df.street.str.contains(" / ", regex=False)].groupby(["street", "city"]).size().rename("n").reset_index()

    rows = []
    for r in inter.itertuples():
        a_name, b_name = [norm_cad(p) for p in r.street.split(" / ")][:2]
        a, b = gc.street(a_name, r.city), gc.street(b_name, r.city)
        if not (a and b) or a["precision"] != "street" or b["precision"] != "street":
            continue
        x = a["geom"].intersection(b["geom"])
        if x.geom_type != "Point":
            continue
        truth = np.array([(x if x.geom_type == "Point" else x.representative_point()).x,
                          (x if x.geom_type == "Point" else x.representative_point()).y])
        town = gc.municipality_point(r.city)[0]
        for hit in (a, b):
            res = {"street": hit["matched"], "city": r.city, "n": r.n, "length_m": hit["geom"].length,
                   "town_center": np.linalg.norm(town - truth)}
            for m in ("midpoint", "uniform", "address"):
                p = gc.place_on(hit, m)[0]
                res[m] = np.linalg.norm(np.asarray(p) - truth)
            rows.append(res)
    ev = pd.DataFrame(rows)
    print(f"test cases: {len(ev)} street placements from {ev.n.sum() // 2} intersection calls\n")
    print("Comparison only: inferred TIGER crossings, not independent incident ground truth or a representative accuracy sample.\n")
    methods = ["town_center", "midpoint", "uniform", "address"]

    def wq(col, q):
        s = ev.sort_values(col)
        c = s.n.cumsum() / s.n.sum()
        return s[col].iloc[int(np.searchsorted(c, q))]

    tbl = pd.DataFrame({m: {"median_m": wq(m, .5), "mean_m": np.average(ev[m], weights=ev.n),
                            "p80_m": wq(m, .8), "within_500m": np.average(ev[m] <= 500, weights=ev.n)}
                        for m in methods}).T.round(2)
    print("call-weighted error by method:\n" + tbl.to_string())
    for lo, hi in [(0, 1000), (1000, 3000), (3000, 1e9)]:
        s = ev[(ev.length_m >= lo) & (ev.length_m < hi)]
        if len(s):
            print(f"  streets {lo/1000:.0f}-{hi/1000:.0f} km: n={len(s)}  " +
                  "  ".join(f"{m} {np.average(s[m], weights=s.n):.0f} m" for m in methods))
    wins = (ev.address < ev.midpoint - 1).mul(ev.n).sum(), (ev.midpoint < ev.address - 1).mul(ev.n).sum()
    print(f"address beats midpoint on {wins[0]} call-weighted street placements, loses on {wins[1]} (two street placements per intersection dispatch)")

    loc = pd.read_csv(ROOT / "geo" / "locations.csv", keep_default_na=False)
    for meth in ("fuzzy", "landmark", "alias"):
        s = loc[loc.match_method == meth].sort_values("records", ascending=False)
        print(f"\n{meth} matches ({len(s)} places, {s.records.astype(int).sum()} records), top 30:")
        print(s.head(30)[["street", "city", "matched_name", "records"]].to_string(index=False))


if __name__ == "__main__":
    main()

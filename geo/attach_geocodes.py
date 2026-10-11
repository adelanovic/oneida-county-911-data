"""Add geocoded location columns from geo/locations.csv to output/oneida_911_records.csv (re-runnable).

Run after build_dataset.py and geo/geocode.py. Adds:
  geo_latitude, geo_longitude   estimated point (see geo/geocode.py for how it is chosen)
  geo_precision                 coordinates | intersection | street | street_nearby | landmark | municipality | none
  geo_match_method              exact | alias | ordinal | spelling | fuzzy | fuzzy_risky | landmark | municipality ...
  geo_expected_error_m          typical distance between the point and where on the street the call really was
"""
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
GEO_COLS = ["geo_latitude", "geo_longitude", "geo_precision", "geo_match_method", "geo_expected_error_m"]


def main():
    path = ROOT / "output" / "oneida_911_records.csv"
    df = pd.read_csv(path, keep_default_na=False, low_memory=False)
    df = df.drop(columns=[c for c in GEO_COLS if c in df.columns])
    loc = pd.read_csv(ROOT / "geo" / "locations.csv", keep_default_na=False)
    loc = loc.rename(columns={"latitude": "geo_latitude", "longitude": "geo_longitude", "precision": "geo_precision",
                              "match_method": "geo_match_method", "expected_error_m": "geo_expected_error_m"})
    for c in ["geo_latitude", "geo_longitude"]:
        loc[c] = pd.to_numeric(loc[c], errors="coerce").round(6)
    out = df.merge(loc[["street", "city"] + GEO_COLS], on=["street", "city"], how="left", validate="many_to_one")
    assert len(out) == len(df)
    out["geo_precision"] = out.geo_precision.replace("", "none").fillna("none")
    # Put the geo columns right after the reported coordinates.
    cols = list(df.columns)
    i = cols.index("location_missing") + 1
    out = out[cols[:i] + GEO_COLS + cols[i:]]
    out.to_csv(path, index=False, encoding="utf-8")
    print(out.geo_precision.value_counts(normalize=True).round(4).to_string())


if __name__ == "__main__":
    main()

"""Refresh a reviewed municipal road-reference subset from Oneida County's public GIS.

The checked-in snapshot is used offline by the map build. Refreshing it is an explicit
maintenance action; ordinary builds never query the live service. No dispatch data is sent.
"""
import csv
import argparse
import datetime
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "geo"))
from geocode import county_name_key, COUNTY_REFERENCES, COUNTY_NAME_ALIASES  # noqa: E402

SERVICE = "https://maps.oneidacountyny.gov/arcgis/rest/services/E911_CAD/E911_CAD/MapServer/0"


def query(params):
    url = SERVICE + "/query?" + urllib.parse.urlencode({"f": "json", **params})
    req = urllib.request.Request(url, headers={"User-Agent": "Oneida911Dataset/1.0"})
    with urllib.request.urlopen(req, timeout=45) as response:
        data = json.load(response)
    if "error" in data or data.get("exceededTransferLimit"):
        raise ValueError(f"Incomplete county reference response: {data.get('error', 'transfer limit')}")
    return data, url


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--city", choices=COUNTY_REFERENCES, default="UTICA")
    parser.add_argument("--add-name", action="append", default=[], help="Explicit reported name to review in this subset (repeatable)")
    parser.add_argument("--include-candidates", action="store_true", help="Also discover fallbacks, fuzzy, disconnected and qualified matches; review the resulting diff")
    args = parser.parse_args()
    city = args.city
    target = ROOT / "geo/reference" / COUNTY_REFERENCES[city]
    previous = {}
    if target.exists():
        previous = json.loads(target.read_text(encoding="utf-8"))
        names = previous["requested_names"]
    else:
        names = []
    if not names or args.include_candidates:
        with (ROOT / "geo/locations.csv").open(encoding="utf-8", newline="") as f:
            names = sorted(set(names) | {r["street"] for r in csv.DictReader(f) if r["city"] == city and (
                r["precision"] == "municipality" or r["match_method"] == "fuzzy" or
                float(r["n_pieces"] or 0) > 1 or re.search(r"\b(?:EB|WB|NB|SB|RAMP|EXIT)\b", r["street"]))})
    names = sorted(set(names) | set(args.add_name))
    literal = lambda s: "'" + s.upper().replace("'", "''") + "'"
    labels = previous.get("source_labels", [city, "ROME"] if city in {"ROME INSIDE", "ROME OUTSIDE"} else [city])
    label_sql = ",".join(map(literal, labels))
    area = f"(UPPER(CITY_LEFT) IN ({label_sql}) OR UPPER(CITY_RIGHT) IN ({label_sql}))"
    distinct, _ = query(dict(where=area, outFields="FULL_STNAM",
                             returnGeometry="false", returnDistinctValues="true", orderByFields="FULL_STNAM"))
    aliases = {n: name for n, name in {**previous.get("reviewed_aliases", {}), **COUNTY_NAME_ALIASES.get(city, {})}.items() if n in names}
    county_keys = {county_name_key(f["attributes"]["FULL_STNAM"]) for f in distinct["features"] if f["attributes"]["FULL_STNAM"]}
    for name in names:
        alias = re.sub(r"^(?:NY STATE|NYS) THRUWAY\b", "INTERSTATE 90", name)
        if alias != name and county_name_key(alias) in county_keys:
            aliases[name] = alias  # Road identity only; direction and exit qualifiers remain intact.
    keys = {county_name_key(aliases.get(n, n)) for n in names}
    selected = sorted({f["attributes"]["FULL_STNAM"] for f in distinct["features"]
                       if f["attributes"]["FULL_STNAM"] and county_name_key(f["attributes"]["FULL_STNAM"]) in keys})
    if not selected:
        raise ValueError("No reviewed street names found in county reference")
    features, urls = [], []
    for start in range(0, len(selected), 25):
        where = area + " AND UPPER(FULL_STNAM) IN (" + ",".join(map(literal, selected[start:start+25])) + ")"
        data, source_url = query(dict(where=where, outFields="OBJECTID,FULL_STNAM,CITY_LEFT,CITY_RIGHT,DATEUPDATE,ADD_SOURCE",
                                     returnGeometry="true", outSR="4326", orderByFields="OBJECTID"))
        features.extend(data["features"])
        urls.append(source_url)
    snapshot = dict(city=city, source=SERVICE, source_labels=labels, query_urls=urls,
                    retrieved_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
                    requested_names=names, reviewed_aliases=aliases, street_names=selected, features=features)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(snapshot, indent=2) + "\n", encoding="utf-8")
    print(f"{target.relative_to(ROOT)}: {len(features)} road segments on {len(selected)} reference street names")
    print("Review the diff and spatial checks before using updated reference points.")


if __name__ == "__main__":
    main()

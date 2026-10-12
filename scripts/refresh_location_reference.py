"""Refresh a reviewed municipal road-reference subset from Oneida County's public GIS.

The checked-in snapshot is used offline by the map build. Refreshing it is an explicit
maintenance action; ordinary builds never query the live service. No dispatch data is sent.
"""
import csv
import argparse
import datetime
import json
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
    city = parser.parse_args().city
    target = ROOT / "geo/reference" / COUNTY_REFERENCES[city]
    if target.exists():
        names = json.loads(target.read_text(encoding="utf-8"))["requested_names"]
    else:
        with (ROOT / "geo/locations.csv").open(encoding="utf-8", newline="") as f:
            names = sorted({r["street"] for r in csv.DictReader(f)
                            if r["city"] == city and r["precision"] == "municipality"})
    literal = lambda s: "'" + s.upper().replace("'", "''") + "'"
    labels = [city, "ROME"] if city in {"ROME INSIDE", "ROME OUTSIDE"} else [city]
    label_sql = ",".join(map(literal, labels))
    area = f"(UPPER(CITY_LEFT) IN ({label_sql}) OR UPPER(CITY_RIGHT) IN ({label_sql}))"
    distinct, _ = query(dict(where=area, outFields="FULL_STNAM",
                             returnGeometry="false", returnDistinctValues="true", orderByFields="FULL_STNAM"))
    aliases = {n: target for n, target in COUNTY_NAME_ALIASES.get(city, {}).items() if n in names}
    keys = {county_name_key(aliases.get(n, n)) for n in names}
    selected = sorted({f["attributes"]["FULL_STNAM"] for f in distinct["features"]
                       if f["attributes"]["FULL_STNAM"] and county_name_key(f["attributes"]["FULL_STNAM"]) in keys})
    if not selected:
        raise ValueError("No reviewed street names found in county reference")
    where = area + " AND UPPER(FULL_STNAM) IN (" + ",".join(map(literal, selected)) + ")"
    data, source_url = query(dict(where=where, outFields="OBJECTID,FULL_STNAM,CITY_LEFT,CITY_RIGHT,DATEUPDATE,ADD_SOURCE",
                                  returnGeometry="true", outSR="4326", orderByFields="OBJECTID"))
    snapshot = dict(city=city, source=SERVICE, query_url=source_url,
                    retrieved_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
                    requested_names=names, reviewed_aliases=aliases, street_names=selected, features=data["features"])
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(snapshot, indent=2) + "\n", encoding="utf-8")
    print(f"{target.relative_to(ROOT)}: {len(data['features'])} road segments on {len(selected)} reference street names")
    print("Review the diff and spatial checks before using updated reference points.")


if __name__ == "__main__":
    main()

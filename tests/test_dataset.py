"""Regression checks against rebuilt artifacts and their reported-source fields."""
import base64
import json
import re
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent


class DatasetRegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.df = pd.read_csv(ROOT / "output/oneida_911_records.csv", keep_default_na=False, low_memory=False)
        cls.data = json.loads((ROOT / "geo/map_data.json").read_text(encoding="utf-8"))
        cls.records = {k: np.frombuffer(base64.b64decode(v), dtype="<u4" if k in ["i", "z"] else
                                      "<u2" if k in ["t", "d", "l", "k", "s", "f", "v", "r"] else "u1")
                       for k, v in cls.data["records"].items()}

    def test_reported_coordinates_survive(self):
        df = self.df
        reported = df[df.latitude != ""]
        self.assertGreater(len(reported), 0)
        self.assertTrue(reported.geo_precision.eq("coordinates").all())
        np.testing.assert_allclose(reported.latitude.astype(float), reported.geo_latitude.astype(float), atol=1e-9)
        np.testing.assert_allclose(reported.longitude.astype(float), reported.geo_longitude.astype(float), atol=1e-9)
        for i in reported.index:
            point = self.data["locations"][int(self.records["l"][i]) - 1]
            self.assertAlmostEqual(point[0], float(df.latitude.iat[i]), places=4)
            self.assertAlmostEqual(point[1], float(df.longitude.iat[i]), places=4)

    def test_absent_locations_stay_unmapped(self):
        missing = self.df.location_missing
        self.assertTrue(self.df.loc[missing, "geo_precision"].eq("none").all())
        self.assertTrue((self.records["l"][missing] == 0).all())
        self.assertTrue((self.records["q"] == missing.astype(int)).all())

    def test_cluster_boundaries_and_agencies(self):
        df = self.df
        groups = df.groupby("incident_cluster_id")
        bounds = groups.call_datetime.agg(["min", "max"])
        span = (pd.to_datetime(bounds["max"]) - pd.to_datetime(bounds["min"])).dt.total_seconds()
        self.assertTrue((span <= 120).all())
        self.assertTrue((groups.city.nunique() <= 1).all())
        self.assertTrue((groups.latitude.nunique() <= 1).all())
        unknown = df.location_missing & df.city.eq("")
        self.assertTrue(groups.size().loc[df.loc[unknown, "incident_cluster_id"]].eq(1).all())
        expected = groups.agency.transform("nunique")
        np.testing.assert_array_equal(self.records["k"], expected)
        np.testing.assert_array_equal(self.records["i"], df.incident_cluster_id)

    def test_risky_number_match_is_rejected(self):
        loc = pd.read_csv(ROOT / "geo/locations.csv", keep_default_na=False)
        park = loc[loc.street.eq("PARK DRIVE MNR 2")]
        self.assertGreater(len(park), 0)
        self.assertFalse(park.matched_name.str.contains("MANOR 1").any())
        self.assertFalse(loc.match_method.eq("fuzzy_risky").any())

    def test_export_fields_preserve_source(self):
        df, d, r = self.df, self.data, self.records
        self.assertEqual(len(df), d["total"])
        for values in r.values():
            self.assertEqual(len(values), len(df))
        self.assertEqual([d["streets"][int(i)] for i in r["s"]], df.street.tolist())
        self.assertEqual([d["agencies"][int(i)] for i in r["u"]], df.agency.tolist())
        self.assertEqual([d["sources"][int(i)] for i in r["f"]], df.source_file.tolist())
        dt = pd.to_datetime(df.call_datetime)
        np.testing.assert_array_equal(r["z"], dt.dt.hour * 3600 + dt.dt.minute * 60 + dt.dt.second)

    def test_pages_match_data_and_vendor_leaflet(self):
        page = (ROOT / "docs/index.html").read_text(encoding="utf-8")
        self.assertEqual(page, (ROOT / "output/map/oneida_911_map.html").read_text(encoding="utf-8"))
        embedded = re.search(r'<script id="data" type="application/json">(.*?)</script>', page, re.S)[1]
        self.assertEqual(json.loads(embedded), self.data)
        self.assertNotIn("__LEAFLET", page)
        self.assertNotIn('src="https://cdnjs.cloudflare.com', page)


if __name__ == "__main__":
    unittest.main()

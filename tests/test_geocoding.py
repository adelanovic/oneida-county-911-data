"""Spatial regressions for local matching and conservative point placement."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pandas as pd
from shapely.geometry import LineString, Point, box
from shapely.ops import unary_union

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "geo"))
from geocode import Geocoder, medoid, to_m  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]


class GeocodingRegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.gc = Geocoder()
        cls.locations = pd.read_csv(ROOT / "geo/locations.csv", keep_default_na=False)

    def test_local_ordinal_beats_same_name_elsewhere(self):
        for city in ["ROME INSIDE", "UTICA", "CAMDEN VILLAGE", "YORKVILLE VILLAGE"]:
            hit = self.gc.street("SECOND ST", city)
            self.assertIsNotNone(hit, city)
            self.assertEqual(hit["matched"], "2ND ST", city)
            self.assertEqual(hit["precision"], "street", city)
            stored = self.locations[(self.locations.street == "SECOND ST") & (self.locations.city == city)].iloc[0]
            self.assertEqual(stored.matched_name, "2ND ST", city)
            self.assertEqual(stored.precision, "street", city)

    def test_outside_whole_road_fallback_is_rejected(self):
        for name, city in [("OLD STATE RD", "TRENTON"), ("ROUTE 49", "WHITESTOWN"),
                           ("ROME NEW LONDON RD", "ROME OUTSIDE")]:
            hit = self.gc.street(name, city)
            if hit is not None:  # A valid local spelling match is also acceptable.
                self.assertEqual(hit["precision"], "street")
                p = self.gc.place_on(hit)[0]
                self.assertLessEqual(Point(p).distance(self.gc.poly(city)), self.gc.BUF + 1)

    def test_missing_direction_does_not_choose_between_east_and_west(self):
        self.assertEqual(self.gc.resolve("ERIE BLVD", "ROME INSIDE"), (None, None))

    def test_all_street_estimates_respect_municipality_tolerance(self):
        for r in self.locations[self.locations.precision.isin(["street", "street_nearby"])].itertuples():
            muni = self.gc.poly(r.city) if r.city else None
            if muni is not None:
                self.assertEqual(r.precision, "street", (r.street, r.city))
                distance = to_m(Point(float(r.longitude), float(r.latitude))).distance(muni)
                self.assertLessEqual(distance, self.gc.BUF + 1, (r.street, r.city, distance))

    def test_clipping_preserves_address_density(self):
        gc = Geocoder.__new__(Geocoder)
        first = LineString([(-100, 0), (100, 0)])
        second = LineString([(0, 100), (100, 100)])
        gc.addr = {"TEST": [(first, 100), (second, 50)]}
        area = box(0, -1, 100, 101)
        hit = dict(matched="TEST", geom=unary_union([first.intersection(area), second]), area=area)
        def check_weights(pts, ws):
            np.testing.assert_allclose(ws[pts[:, 1] == 0].sum(), 50)
            np.testing.assert_allclose(ws[pts[:, 1] == 100].sum(), 50)
            return medoid(pts, ws)
        with patch("geocode.medoid", side_effect=check_weights):
            gc.place_on(hit)

    def test_implausible_address_ranges_do_not_dominate(self):
        gc = Geocoder.__new__(Geocoder)
        suspect = LineString([(0, 0), (58, 0)])
        normal = LineString([(0, 100), (100, 100)])
        gc.addr = {"TEST": [(suspect, 4812), (normal, 50)]}
        p, _, _ = gc.place_on(dict(matched="TEST", geom=unary_union([suspect, normal]), area=None))
        self.assertGreater(p[1], 90)

    def test_related_facility_is_not_an_exact_landmark(self):
        self.assertIsNone(self.gc.landmark("TURNING STONE CASINO RESORT", "VERONA"))
        landmarks = self.locations[self.locations.precision == "landmark"]
        self.assertTrue(landmarks.expected_error_m.eq("").all())
        self.assertFalse(landmarks.matched_name.str.contains("Heliport", case=False).any())


if __name__ == "__main__":
    unittest.main()

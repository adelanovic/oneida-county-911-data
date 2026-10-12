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
from geocode import Geocoder, medoid, to_m, norm_cad, county_name_key  # noqa: E402

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

    def test_county_reference_resolves_missing_streets_locally(self):
        for name in ["HOSPITAL DR", "UTICA ZOO WAY", "WEAVER ST", "TRENTON AVE", "HARBOR PT"]:
            hit = self.gc.county_street(name, "UTICA")
            self.assertIsNotNone(hit, name)
            self.assertEqual(hit["method"], "county_roads")
            self.assertLessEqual(hit["geom"].difference(self.gc.poly("UTICA").buffer(self.gc.BUF)).length, .01)
            self.assertIsNone(self.gc.county_street(name, "ROME INSIDE"))
            stored = self.locations[(self.locations.street == name) & (self.locations.city == "UTICA")].iloc[0]
            self.assertEqual(stored.match_method, "county_roads", name)

    def test_county_reference_preserves_direction_and_ramp(self):
        main = self.gc.county_street("N SOUTH ARTERIAL", "UTICA")
        ramp = self.gc.county_street("N SOUTH ARTERIAL RAMP", "UTICA")
        self.assertIsNotNone(main)
        self.assertIsNotNone(ramp)
        self.assertNotEqual(main["matched"], ramp["matched"])
        self.assertNotEqual(county_name_key("DAWES CT E"), county_name_key("DAWES CT W"))
        self.assertIsNone(self.gc.county_street("DAWES CT", "UTICA"))
        self.assertIsNone(self.gc.county_street("WEAVER RD", "UTICA"))

    def test_whitesboro_county_matches_preserve_local_street_identity(self):
        for name in ["ELLIS AVE", "DEXTER ST", "COMMERCIAL DRIVE RAMP"]:
            hit = self.gc.county_street(name, "WHITESBORO VILLAGE")
            self.assertIsNotNone(hit, name)
            self.assertEqual(hit["matched"], name)
            self.assertEqual(hit["precision"], "street")
            self.assertLessEqual(hit["geom"].difference(self.gc.poly("WHITESBORO VILLAGE").buffer(self.gc.BUF)).length, .01)
            self.assertIsNone(self.gc.county_street(name, "WHITESTOWN"))
            stored = self.locations[(self.locations.street == name) & (self.locations.city == "WHITESBORO VILLAGE")].iloc[0]
            self.assertEqual(stored.match_method, "county_roads")
        self.assertNotEqual(self.gc.county_street("DEXTER ST", "WHITESBORO VILLAGE")["matched"],
                            self.gc.street("DEXTER AVE", "WHITESBORO VILLAGE")["matched"])

    def test_whitesboro_school_is_approximate_facility(self):
        stored = self.locations[(self.locations.street == "WHITESBORO MIDDLE SCHOOL") &
                                (self.locations.city == "WHITESBORO VILLAGE")].iloc[0]
        self.assertEqual(stored.precision, "landmark")
        self.assertEqual(stored.match_method, "county_roads")
        self.assertEqual(stored.expected_error_m, "")

    def test_whitesboro_repeated_place_suffix_is_scoped_alias(self):
        hit = self.gc.street("MAIN ST, WHITESBORO", "WHITESBORO VILLAGE")
        original = self.gc.street("MAIN ST", "WHITESBORO VILLAGE")
        self.assertEqual(hit["matched"], "MAIN ST")
        self.assertEqual(hit["method"], "reviewed_alias")
        self.assertTrue(hit["geom"].equals(original["geom"]))
        self.assertIsNone(self.gc.street("MAIN ST, WHITESBORO", "UTICA"))

    def test_incomplete_whitesboro_labels_stay_approximate(self):
        for name in ["2 1", "12 1"]:
            stored = self.locations[(self.locations.street == name) & (self.locations.city == "WHITESBORO VILLAGE")].iloc[0]
            self.assertEqual(stored.precision, "municipality")

    def test_marcy_reference_resolves_named_streets_in_marcy(self):
        for name in ["OLD RIVER RD", "RESIDENTIAL DR", "SEYMOUR RD", "HILLTOP DR", "WILDCAT DR",
                     "TECHNOLOGY DR", "MARCY-SUNY PKWY"]:
            hit = self.gc.county_street(name, "MARCY")
            self.assertIsNotNone(hit, name)
            self.assertEqual(hit["matched"], name)
            self.assertEqual(hit["precision"], "street")
            self.assertLessEqual(hit["geom"].difference(self.gc.poly("MARCY").buffer(self.gc.BUF)).length, .01)
            self.assertIsNone(self.gc.county_street(name, "WHITESTOWN"))
            stored = self.locations[(self.locations.street == name) & (self.locations.city == "MARCY")].iloc[0]
            self.assertEqual(stored.match_method, "county_roads")

    def test_marcy_generic_turnaround_does_not_choose_between_distinct_sites(self):
        self.assertEqual(len(self.gc.county_roads["MARCY", county_name_key("U TURN")]), 2)
        self.assertIsNone(self.gc.county_street("U TURN", "MARCY"))
        stored = self.locations[(self.locations.street == "U TURN") & (self.locations.city == "MARCY")].iloc[0]
        self.assertEqual(stored.precision, "municipality")

    def test_kennedy_complex_estimates_do_not_claim_incident_accuracy(self):
        points = set()
        for suffix in ["HI RISE", "E", "W", "ENTRANCE"]:
            name = "KENNEDY PLAZA APTS " + suffix
            stored = self.locations[(self.locations.street == name) & (self.locations.city == "UTICA")].iloc[0]
            self.assertEqual(stored.precision, "landmark")
            self.assertEqual(stored.match_method, "county_roads")
            self.assertEqual(stored.expected_error_m, "")
            points.add((stored.latitude, stored.longitude))
        self.assertEqual(len(points), 4)

    def test_alphanumeric_house_number_does_not_break_numbered_streets(self):
        self.assertEqual(norm_cad("1131A SEYMOUR AVE"), "SEYMOUR AVE")
        self.assertEqual(norm_cad("6 ST"), "6 ST")
        self.assertEqual(norm_cad("6TH ST"), "6TH ST")

    def test_rome_county_names_are_scoped_and_clipped(self):
        for name in ["DART CIR", "AIR CITY BLVD", "GEIGER RD", "N DOXTATOR AVE", "S DOXTATOR AVE",
                     "BROADWAY ST", "BOMBER DR", "BATEAUX PL"]:
            hit = self.gc.county_street(name, "ROME INSIDE")
            self.assertIsNotNone(hit, name)
            self.assertEqual(hit["precision"], "street")
            self.assertEqual(hit["method"], "county_roads")
            self.assertLessEqual(hit["geom"].difference(self.gc.poly("ROME INSIDE").buffer(self.gc.BUF)).length, .01)
            self.assertIsNone(self.gc.county_street(name, "WHITESTOWN"))
        self.assertIsNone(self.gc.county_street("DART CIR", "ROME OUTSIDE"))
        self.assertIsNone(self.gc.county_street("ERIE BLVD W", "ROME INSIDE"))
        existing = self.locations[(self.locations.street == "ERIE BLVD W") & (self.locations.city == "ROME INSIDE")].iloc[0]
        self.assertEqual(existing.match_method, "exact")

    def test_rome_facility_locations_do_not_claim_incident_accuracy(self):
        for name in ["PARK DRIVE MNR 2", "REVERE PK", "MOHAWK ACRS NORTH", "FORT STANWIX PK SOUTH", "RCH"]:
            r = self.locations[(self.locations.street == name) & (self.locations.city == "ROME INSIDE")].iloc[0]
            self.assertEqual(r.precision, "landmark", name)
            self.assertEqual(r.match_method, "county_roads", name)
            self.assertEqual(r.expected_error_m, "", name)

    def test_rome_reviewed_corrections_preserve_directions(self):
        for reported, matched in [("BLACK RVER BLVD", "BLACK RIVER BLVD"),
                                  ("ERIE BLVD BLVD W", "ERIE BLVD WEST"), ("NORTH JAMES", "NORTH JAMES ST")]:
            hit = self.gc.county_street(reported, "ROME INSIDE")
            self.assertEqual(hit["matched"], matched)
            self.assertEqual(hit["method"], "county_roads_alias")
            self.assertIsNone(self.gc.county_street(reported, "ROME OUTSIDE"))

    def test_rome_ambiguous_names_are_not_forced_to_a_candidate(self):
        for name, city in [("ERIE BLVD", "ROME INSIDE"), ("FOX ST", "ROME INSIDE"),
                           ("BLACK RIVER RD", "ROME INSIDE"), ("W DOMINICK RD", "ROME INSIDE"),
                           ("U TURN", "ROME OUTSIDE")]:
            self.assertIsNone(self.gc.county_street(name, city))
            r = self.locations[(self.locations.street == name) & (self.locations.city == city)].iloc[0]
            self.assertEqual(r.precision, "municipality", name)

    def test_county_house_numbers_and_ramp_names_do_not_erase_qualifiers(self):
        self.assertEqual(county_name_key("112B NORTH DOXTATOR AVE"), county_name_key("N DOXTATOR AVE"))
        self.assertEqual(county_name_key("BATEAUX PLACE"), county_name_key("BATEAUX PL"))
        self.assertEqual(county_name_key("STATE ROUTE 49 EAST RAMP"), county_name_key("ROUTE 49 E RAMP"))
        self.assertNotEqual(county_name_key("ROUTE 49 EAST RAMP"), county_name_key("ROUTE 49 WEST RAMP"))
        self.assertNotEqual(county_name_key("ROUTE 49 EAST RAMP"), county_name_key("ROUTE 49"))
        self.assertEqual(county_name_key("ROUTE 26 / ROUTE 365 RAMP"), county_name_key("ROUTE 26 ROUTE 365 RAMP"))
        a = self.gc.county_street("105 N DOXTATOR AVE", "ROME INSIDE")
        b = self.gc.county_street("N DOXTATOR AVE", "ROME INSIDE")
        self.assertTrue(a["geom"].equals(b["geom"]))
        self.assertIsNotNone(self.gc.county_street("ROUTE 26 ROUTE 365 RAMP", "ROME OUTSIDE"))

    def test_verona_named_roads_use_local_county_geometry(self):
        for name in ["MERRY ST", "KELLY AVE", "MAPLE AVE", "VOLUNTEER RD", "LAKE SHORE RD SOUTH",
                     "COUNTY HWY 50", "COUNTY ROUTE 50"]:
            hit = self.gc.county_street(name, "VERONA")
            self.assertIsNotNone(hit, name)
            self.assertEqual(hit["precision"], "street")
            self.assertLessEqual(hit["geom"].difference(self.gc.poly("VERONA").buffer(self.gc.BUF)).length, .01)
            self.assertIsNone(self.gc.county_street(name, "WESTMORELAND"))
            r = self.locations[(self.locations.street == name) & (self.locations.city == "VERONA")].iloc[0]
            self.assertEqual(r.precision, "street", name)
        self.assertEqual(self.gc.county_street("COUNTY HWY 50", "VERONA")["matched"], "COUNTY ROUTE 50")

    def test_verona_thruway_aliases_preserve_direction_and_exit(self):
        for reported, matched in [("NY STATE THRUWAY WB", "INTERSTATE 90 WB"),
                                  ("NY STATE THRUWAY EB", "INTERSTATE 90 EB"),
                                  ("NYS THRUWAY EXIT 33", "INTERSTATE 90 EXIT 33"),
                                  ("NY STATE THRUWAY EXIT 33 RAMP", "INTERSTATE 90 EXIT 33 RAMP")]:
            hit = self.gc.county_street(reported, "VERONA")
            self.assertEqual(hit["matched"], matched)
            self.assertEqual(hit["precision"], "street")
        east = self.gc.county_street("NY STATE THRUWAY EB", "VERONA")
        west = self.gc.county_street("NY STATE THRUWAY WB", "VERONA")
        self.assertGreater(east["geom"].length, 10000)
        self.assertGreater(west["geom"].length, 10000)
        self.assertFalse(east["geom"].equals(west["geom"]))
        for name in ["U TURN", "NY STATE THRUWAY RAMP"]:
            self.assertIsNone(self.gc.county_street(name, "VERONA"))
            r = self.locations[(self.locations.street == name) & (self.locations.city == "VERONA")].iloc[0]
            self.assertEqual(r.precision, "municipality")

    def test_verona_facilities_and_parking_do_not_claim_incident_accuracy(self):
        for name in ["MARION MANOR", "MARION MNR", "TURNING STONE CASINO RESORT",
                     "VILLAGES AT STONEY CREEK", "NYS THRUWAY WB PARKING", "NYS THRUWAY EB PARKING"]:
            r = self.locations[(self.locations.street == name) & (self.locations.city == "VERONA")].iloc[0]
            self.assertEqual(r.precision, "landmark", name)
            self.assertTrue(r.match_method.startswith("county_roads"), name)
            self.assertEqual(r.expected_error_m, "", name)

    def test_westmoreland_named_streets_are_local_and_preserve_qualifiers(self):
        for name in ["STOP 7 RD", "ABBE BLVD SOUTH", "DENSLOW DR", "BLACKBERRY PATCH RD", "CHURCH ST"]:
            hit = self.gc.county_street(name, "WESTMORELAND")
            self.assertIsNotNone(hit, name)
            self.assertEqual(hit["matched"], name)
            self.assertEqual(hit["precision"], "street")
            self.assertGreater(hit["geom"].intersection(self.gc.poly("WESTMORELAND")).length, 0)
            self.assertLessEqual(hit["geom"].difference(self.gc.poly("WESTMORELAND").buffer(self.gc.BUF)).length, .01)
            self.assertIsNone(self.gc.county_street(name, "VERONA"))
            r = self.locations[(self.locations.street == name) & (self.locations.city == "WESTMORELAND")].iloc[0]
            self.assertEqual(r.precision, "street", name)
        self.assertIsNone(self.gc.county_street("ABBE BLVD", "WESTMORELAND"))
        self.assertIsNone(self.gc.county_street("STOP 8 RD", "WESTMORELAND"))

    def test_westmoreland_thruway_aliases_keep_directions_and_exit_number(self):
        for reported, matched in [("NY STATE THRUWAY EB", "INTERSTATE 90 EB"),
                                  ("NY STATE THRUWAY WB", "INTERSTATE 90 WB"),
                                  ("NYS THRUWAY EXIT 32", "INTERSTATE 90 EXIT 32"),
                                  ("NY STATE THRUWAY EXIT 32 RAMP", "INTERSTATE 90 EXIT 32 RAMP"),
                                  ("NYS THRUWAY EXIT 32 RAMP", "INTERSTATE 90 EXIT 32 RAMP")]:
            hit = self.gc.county_street(reported, "WESTMORELAND")
            self.assertEqual(hit["matched"], matched)
            self.assertEqual(hit["precision"], "street")
            self.assertLessEqual(hit["geom"].difference(self.gc.poly("WESTMORELAND").buffer(self.gc.BUF)).length, .01)
            if "EXIT 32" in reported:
                self.assertIsNone(self.gc.county_street(reported, "VERONA"))
        east = self.gc.county_street("NY STATE THRUWAY EB", "WESTMORELAND")
        west = self.gc.county_street("NY STATE THRUWAY WB", "WESTMORELAND")
        self.assertFalse(east["geom"].equals(west["geom"]))
        self.assertIsNone(self.gc.county_street("NY STATE THRUWAY RAMP", "WESTMORELAND"))
        r = self.locations[(self.locations.street == "NY STATE THRUWAY RAMP") & (self.locations.city == "WESTMORELAND")].iloc[0]
        self.assertEqual(r.precision, "municipality")

    def test_westmoreland_service_area_is_an_approximate_facility(self):
        for name in ["ONEIDA SERVICE CENTER", "THRUWAY SERVICE ENTRANCE"]:
            r = self.locations[(self.locations.street == name) & (self.locations.city == "WESTMORELAND")].iloc[0]
            self.assertEqual(r.precision, "landmark", name)
            self.assertTrue(r.match_method.startswith("county_roads"), name)
            self.assertEqual(r.expected_error_m, "", name)
        a = self.gc.county_street("ONEIDA SERVICE CENTER", "WESTMORELAND")
        b = self.gc.county_street("THRUWAY SERVICE ENTRANCE", "WESTMORELAND")
        self.assertFalse(a["geom"].equals(b["geom"]))

    def test_kirkland_county_streets_preserve_local_names_and_directions(self):
        for name in ["GREEN APPLE WAY", "MAIN QUAD LN", "MUSEUM LN", "STAFFORD CIR N", "STAFFORD CIR NORTH",
                     "STAFFORD CIR S", "LEWISTON GARDENS RD", "BUNDY CIR", "FARMDALE RD", "FOUNTAIN VW"]:
            hit = self.gc.county_street(name, "KIRKLAND")
            self.assertIsNotNone(hit, name)
            self.assertEqual(hit["precision"], "street")
            self.assertGreater(hit["geom"].intersection(self.gc.poly("KIRKLAND")).length, 0)
            self.assertLessEqual(hit["geom"].difference(self.gc.poly("KIRKLAND").buffer(self.gc.BUF)).length, .01)
            self.assertIsNone(self.gc.county_street(name, "CLINTON VILLAGE"))
            r = self.locations[(self.locations.street == name) & (self.locations.city == "KIRKLAND")].iloc[0]
            self.assertEqual(r.precision, "street", name)
        north = self.gc.county_street("STAFFORD CIR N", "KIRKLAND")
        south = self.gc.county_street("STAFFORD CIR S", "KIRKLAND")
        self.assertFalse(north["geom"].equals(south["geom"]))
        self.assertIsNone(self.gc.county_street("STAFFORD CIR", "KIRKLAND"))
        self.assertIsNone(self.gc.county_street("STAFFORD RD N", "KIRKLAND"))

    def test_utica_street_keeps_kirkland_and_clinton_reporting_areas(self):
        roads = []
        for city in ["KIRKLAND", "CLINTON VILLAGE"]:
            hit = self.gc.county_street("UTICA ST", city)
            self.assertEqual(hit["matched"], "UTICA ST")
            self.assertLessEqual(hit["geom"].difference(self.gc.poly(city).buffer(self.gc.BUF)).length, .01)
            roads.append(hit["geom"])
            r = self.locations[(self.locations.street == "UTICA ST") & (self.locations.city == city)].iloc[0]
            self.assertEqual(r.precision, "street")
        self.assertFalse(roads[0].equals(roads[1]))
        for name in ["W PARK AVE", "BASSETT"]:
            self.assertIsNone(self.gc.county_street(name, "CLINTON VILLAGE"))
            r = self.locations[(self.locations.street == name) & (self.locations.city == "CLINTON VILLAGE")].iloc[0]
            self.assertEqual(r.precision, "municipality", name)
        r = self.locations[(self.locations.street == "SUNSET DR") & (self.locations.city == "CLINTON VILLAGE")].iloc[0]
        self.assertEqual(r.precision, "street")

    def test_new_carriage_house_keeps_facility_and_new_old_distinction(self):
        hit = self.gc.county_street("NEW CARRIAGE HOUSE APTS", "KIRKLAND")
        self.assertEqual(hit["matched"], "NEW CARRIAGE HOUSE APTS")
        self.assertEqual(hit["precision"], "landmark")
        self.assertIsNone(self.gc.county_street("OLDE CARRIAGE HOUSE APTS", "KIRKLAND"))
        r = self.locations[(self.locations.street == "NEW CARRIAGE HOUSE APTS") & (self.locations.city == "KIRKLAND")].iloc[0]
        self.assertEqual(r.precision, "landmark")
        self.assertEqual(r.expected_error_m, "")

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

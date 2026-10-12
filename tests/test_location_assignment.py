"""Regressions for county scope and printed coordinate formats."""
import importlib.util
from pathlib import Path
import math
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("build_dataset", ROOT / "build_dataset.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class LocationAssignmentTests(unittest.TestCase):
    def test_neighboring_places_do_not_default_to_oneida(self):
        for city, county in [("OSWEGO COUNTY", "OSWEGO"), ("PLAINFIELD OTSEGO CO", "OTSEGO"),
                             ("RUSSIA", "HERKIMER"), ("RUSSIA HERKIMER COUNTY", "HERKIMER"),
                             ("CANASTOTA", "MADISON")]:
            self.assertEqual(build.city_parts(city)[3], county, city)
        self.assertEqual(build.city_parts("OSWEGO COUNTY")[0], "")
        self.assertEqual(build.city_parts("UNRECOGNIZED PLACE"), ("", "", "", ""))
        for city in build.ONEIDA_MUNICIPALITIES:
            self.assertEqual(build.city_parts(city)[3], "ONEIDA")

    def test_truncated_new_york_mills_code_has_scoped_correction(self):
        fixed = build.CITY_FIX["NEW YORK MILLS WHITE"]
        self.assertEqual(build.city_parts(fixed), ("WHITESTOWN", "NEW YORK MILLS", "", "ONEIDA"))

    def test_coordinate_separators_and_wrapped_digits(self):
        for text in ["43.16276877161877, -75.92598121626212",
                     "43.162768771618 77, -75.925981216262 12",
                     "43.16276877161877 ~ - 75.92598121626212"]:
            lat, lon = build.parse_coordinates(text)
            self.assertAlmostEqual(lat, 43.16276877161877)
            self.assertAlmostEqual(lon, -75.92598121626212)

    def test_coordinate_parser_requires_complete_valid_pair(self):
        for text in ["114 CHURCH ST", "6 ST", "43.1, -195.2", "93.1, -75.2",
                     "43.1, -75.2 MAIN ST", "MAIN ST 43.1, -75.2", "43.1"]:
            self.assertTrue(all(math.isnan(n) for n in build.parse_coordinates(text)), text)


if __name__ == "__main__":
    unittest.main()

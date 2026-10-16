"""Regression checks against rebuilt artifacts and their reported-source fields."""
import base64
import gzip
import hashlib
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

    def test_population_reporting_areas_match_census_2024(self):
        est = pd.read_csv(ROOT / "geo/census/sub-est.csv", dtype=str, encoding="latin-1")
        est = est[(est.STATE == "36") & (est.COUNTY == "065")]
        column = "POPESTIMATE2024"
        towns = {re.sub(r" (town|city)$", "", r.NAME).upper(): int(getattr(r, column))
                 for r in est[est.SUMLEV == "061"].itertuples()}
        parts = est[est.SUMLEV == "071"]
        # Reporting labels group these entire villages/city into one response area.
        for village, source, target in [("Waterville", "Marshall", "Sangerfield"),
                                        ("Remsen", "Trenton", "Remsen"),
                                        ("Sherrill", "Vernon", "Sherrill")]:
            code = est[(est.SUMLEV == "061") & (est.NAME == source + " town")].COUSUB.iloc[0]
            rows = parts[(parts.COUSUB == code) & parts.NAME.str.startswith(village + " ")]
            amount = rows[column].astype(int).sum()
            self.assertGreater(amount, 0)
            towns[source.upper()] -= amount
            towns[target.upper()] = towns.get(target.upper(), 0) + amount
        pop = self.data["population"]
        self.assertEqual(pop["ALL"], int(est[est.SUMLEV == "050"][column].iloc[0]))
        self.assertEqual(sum(v for k, v in pop.items() if k.startswith("T:")), pop["ALL"])
        for name, value in towns.items():
            self.assertEqual(pop["T:" + name], value, name)
        for name, code in [("NEW HARTFORD", "50309"), ("WHITESTOWN", "81754")]:
            expected = int(parts[(parts.COUSUB == code) & parts.NAME.str.startswith("New York Mills village")][column].iloc[0])
            self.assertEqual(pop["V:" + name + "|NEW YORK MILLS"], expected)

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

    def test_corrected_locations_keep_source_labels_and_coordinates(self):
        df = self.df
        corrected = df[df.city_raw == "NEW YORK MILLS WHITE"]
        self.assertGreater(len(corrected), 0)
        self.assertTrue(corrected.city.eq("NEW YORK MILLS WHITESTOWN").all())
        for row in corrected.itertuples():
            self.assertEqual(self.data["reportedCities"][str(row.Index)], row.city_raw)
        wrapped = df[df.location_raw.eq("43.162768771618 77, -75.925981216262 12")]
        self.assertEqual(len(wrapped), 2)
        self.assertTrue(wrapped.street.eq("").all())
        self.assertTrue(wrapped.geo_precision.eq("coordinates").all())
        self.assertTrue(wrapped.latitude.astype(float).between(43.1627, 43.1628).all())
        self.assertTrue(wrapped.longitude.astype(float).between(-75.9261, -75.9259).all())
        for city, county in [("OSWEGO COUNTY", "OSWEGO"), ("PLAINFIELD OTSEGO CO", "OTSEGO"),
                             ("RUSSIA", "HERKIMER"), ("RUSSIA HERKIMER COUNTY", "HERKIMER"), ("CANASTOTA", "MADISON")]:
            rows = df[df.city == city]
            self.assertTrue(rows.county.eq(county).all(), city)
            self.assertTrue(rows.outside_county.all(), city)

    def test_separate_matching_stretches_are_exposed_to_the_map(self):
        loc = next(row for row in self.data["locations"] if row[2:4] == ["ERIE BLVD W", "ROME INSIDE"])
        self.assertEqual(loc[4], "street")
        self.assertGreater(loc[8], 1)

    def test_weather_annotations_keep_source_context_separate_from_dispatches(self):
        events = json.loads((ROOT / "sources/weather_events.json").read_text(encoding="utf-8"))
        self.assertEqual(self.data["weatherEvents"], events)
        dates = [date for event in events for date in event["dates"]]
        self.assertEqual(set(dates), {"2024-02-28", "2024-02-29", "2024-07-16", "2025-06-22"})
        self.assertEqual(len(dates), len(set(dates)))
        for event in events:
            self.assertTrue(event["source_url"].startswith("https://www.weather.gov/bgm/"))
            self.assertEqual(set(event["replay_start"]), set(event["dates"]))
            for date in event["dates"]:
                self.assertIn(date, self.data["dates"])
                self.assertTrue(0 <= event["replay_start"][date] < 86400)

    def test_absent_locations_stay_unmapped(self):
        missing = self.df.location_missing
        self.assertTrue(self.df.loc[missing, "geo_precision"].eq("none").all())
        self.assertTrue((self.records["l"][missing] == 0).all())
        self.assertTrue((self.records["q"] == missing.astype(int)).all())

    def test_every_packed_location_matches_its_source_record(self):
        ids = self.records["l"].astype(np.int64) - 1
        mapped = ids >= 0
        self.assertTrue((mapped == self.df.geo_precision.ne("none").to_numpy()).all())
        points = np.asarray(self.data["locations"], dtype=object)[ids[mapped]]
        source = self.df.loc[mapped]
        np.testing.assert_array_equal(points[:, 2], source.street)
        np.testing.assert_array_equal(points[:, 3], source.city)
        np.testing.assert_array_equal(points[:, 4], source.geo_precision)
        np.testing.assert_allclose(points[:, :2].astype(float), source[["geo_latitude", "geo_longitude"]].astype(float), atol=0.0000051, rtol=0)

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

    def test_duplicate_report_alias_not_counted_twice(self):
        # These two county PDFs both contain the same 439 August 24 dispatches.
        aliases = self.df[self.df.source_file.str.endswith(("/August-23-2026.pdf", "/August-24-2026.pdf"))]
        self.assertEqual(len(aliases), 439)
        self.assertTrue(aliases.source_file.str.endswith("/August-24-2026.pdf").all())

    def test_cutover_retains_dispatches_missing_from_new_report(self):
        day = self.df[self.df.call_datetime.str.startswith("2025-07-15")]
        old = day[day.report_format.eq("A")]
        self.assertEqual(len(old), 164)
        late = old[old.call_datetime.ge("2025-07-15 09:14:00")]
        self.assertEqual(len(late), 10)
        self.assertEqual(late.agency.eq("New York State Police").sum(), 9)
        alarm = day[day.street.eq("E BLOOMFIELD ST") & day.response_type.eq("ALARM POLICE")]
        self.assertEqual(set(alarm.agency), {"Rome Police Department", "Oneida County Sheriff's Office"})
        self.assertEqual(len(alarm), 2)
        self.assertTrue(alarm.agencies_in_cluster.eq(2).all())

    def test_report_formats_follow_dispatch_dates_in_monthly_pdfs(self):
        formats = self.df.assign(date=self.df.call_datetime.str[:10]).groupby("date").report_format.agg(lambda s: "".join(sorted(set(s))))
        self.assertEqual(self.data["dateReportFormats"], formats.reindex(self.data["dates"]).tolist())
        lookup = dict(zip(self.data["dates"], self.data["dateReportFormats"]))
        self.assertEqual(lookup["2025-07-14"], "A")
        self.assertEqual(lookup["2025-07-15"], "AB")
        self.assertEqual(lookup["2025-08-31"], "B")

    def test_tracked_manifest_retains_all_extracted_sources(self):
        manifest = pd.read_csv(ROOT / "sources/report_manifest.csv", keep_default_na=False)
        log = pd.read_csv(ROOT / "output/extraction_log.csv", keep_default_na=False)
        self.assertEqual(set(manifest.file), set(log.source_file))
        self.assertEqual(len(manifest), len(log))

    def test_pages_match_data_and_vendor_leaflet(self):
        page = (ROOT / "docs/index.html").read_text(encoding="utf-8")
        offline = (ROOT / "output/map/oneida_911_map.html").read_text(encoding="utf-8")
        embedded = lambda text: json.loads(re.search(r'<script id="data" type="application/json">(.*?)</script>', text, re.S)[1])
        self.assertEqual(embedded(offline), self.data)
        config = embedded(page)
        metadata = json.loads(gzip.decompress((ROOT / "docs" / config["metadataUrl"]).read_bytes()))
        binary = gzip.decompress((ROOT / "docs" / config["recordsUrl"]).read_bytes())
        self.assertEqual(len(binary), metadata["recordBytes"])
        self.assertEqual(set(metadata["records"]), set(self.data["records"]))
        self.assertEqual(metadata["formatVersion"], 1)
        self.assertLess(len(page.encode("utf-8")), 600_000)
        for name in ("metadataUrl", "recordsUrl"):
            compressed = (ROOT / "docs" / config[name]).read_bytes()
            self.assertIn(hashlib.sha256(compressed).hexdigest()[:16], config[name])
        for key, field in metadata["records"].items():
            start, size = field["offset"], field["width"] * field["count"]
            self.assertEqual(field["count"], self.data["total"])
            self.assertEqual(start % 4, 0)
            self.assertEqual(binary[start:start + size], base64.b64decode(self.data["records"][key]), key)
        self.assertEqual({k: v for k, v in metadata.items() if k not in ("records", "recordBytes", "formatVersion")},
                         {k: v for k, v in self.data.items() if k != "records"})
        self.assertNotIn("__LEAFLET", page)
        self.assertNotIn('src="https://cdnjs.cloudflare.com', page)


if __name__ == "__main__":
    unittest.main()

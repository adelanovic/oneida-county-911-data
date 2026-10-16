"""Reviewed overlap removal must require the corresponding agency dispatch."""
import importlib.util
from pathlib import Path
import unittest

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("build_dataset", ROOT / "build_dataset.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class ReportOverlapTests(unittest.TestCase):
    def rows(self):
        common = dict(agency="Rome Police Department", response_type="ALARM POLICE",
                      street="E BLOOMFIELD ST", city="ROME INSIDE")
        return pd.DataFrame([
            dict(common, report_format="A", call_datetime="2025-07-15 09:21:49",
                 source_file="reports/2025/07/3067152492444976115_Oneida-County-web-daily-blotter_1056.pdf"),
            dict(common, report_format="B", call_datetime="2025-07-15 09:22:00",
                 source_file="reports/2025/06/July 2025 Media Report.pdf"),
        ])

    def test_requires_replacement_and_same_agency(self):
        rows = self.rows()
        self.assertEqual(build.reviewed_cutover_duplicates(rows).tolist(), [True, False])
        self.assertFalse(build.reviewed_cutover_duplicates(rows.iloc[:1]).any())
        rows.loc[1, "agency"] = "Oneida County Sheriff's Office"
        self.assertFalse(build.reviewed_cutover_duplicates(rows).any())

    def test_ambiguous_replacements_fail_instead_of_losing_rows(self):
        rows = self.rows()
        rows = pd.concat([rows, rows.iloc[1:]], ignore_index=True)
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            build.reviewed_cutover_duplicates(rows)


if __name__ == "__main__":
    unittest.main()

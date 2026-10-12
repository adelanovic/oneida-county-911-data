"""Regression for the recovered report with a headerless continuation page."""
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("extract_raw", ROOT / "extract_raw.py")
extract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extract)


class ExtractionRegressionTests(unittest.TestCase):
    def test_headerless_continuation_preserves_all_dispatches(self):
        path = ROOT / "Oneida_County_911_Reports/reports/2025/01/3067152492444976115_Oneida-County-web-daily-blotter_867.pdf"
        fmt, rows, total, issues = extract.parse_file(path)
        self.assertEqual(fmt, "A")
        self.assertEqual(total, 576)
        self.assertEqual(len(rows), total)
        page = [r for r in rows if r["page"] == 3]
        self.assertEqual(len(page), 38)
        self.assertEqual(page[0]["datetime"], "01/05/2025 05:00:02")
        self.assertEqual(page[0]["response_type"], "MVA-PD")
        self.assertEqual(page[0]["city"], "UTICA")
        self.assertEqual(issues, [])


if __name__ == "__main__":
    unittest.main()

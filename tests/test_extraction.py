"""Regression for the recovered report with a headerless continuation page."""
import importlib.util
from pathlib import Path
import unittest
import tempfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("extract_raw", ROOT / "extract_raw.py")
extract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extract)


class ExtractionRegressionTests(unittest.TestCase):
    def test_manifest_mismatch_fails_before_replacing_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data, out = root / "inputs", root / "output"
            data.mkdir()
            out.mkdir()
            (root / "sources").mkdir()
            header = "file,sha256\n"
            (data / "manifest.csv").write_text(header + "daily.pdf,abc\n", encoding="utf-8")
            (root / "sources/report_manifest.csv").write_text(header + "daily.pdf,abc\nmonthly.pdf,def\n", encoding="utf-8")
            artifact = out / "raw_records.csv"
            artifact.write_text("existing output", encoding="utf-8")
            with patch.multiple(extract, ROOT=root, DATA=data, OUT=out):
                with self.assertRaisesRegex(ValueError, "manifests differ"):
                    extract.main()
            self.assertEqual(artifact.read_text(encoding="utf-8"), "existing output")

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

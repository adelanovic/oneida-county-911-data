"""Restore the public PDF collection and pinned-vintage Census inputs. No third-party dependencies."""
import argparse
import csv
import hashlib
import shutil
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CENSUS = "https://www2.census.gov"
LAYERS = {
    "ROADS": "tl_2024_36065_roads",
    "ADDRFEAT": "tl_2024_36065_addrfeat",
    "FEATNAMES": "tl_2024_36065_featnames",
    "AREAWATER": "tl_2024_36065_areawater",
    "COUSUB": "tl_2024_36_cousub",
    "PLACE": "tl_2024_36_place",
    "POINTLM": "tl_2024_36_pointlm",
    "AREALM": "tl_2024_36_arealm",
}


def download(url, target, sha256=None):
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and (sha256 is None or hashlib.sha256(target.read_bytes()).hexdigest() == sha256):
        return
    request = urllib.request.Request(url, headers={"User-Agent": "Oneida911Dataset/1.0"})
    with urllib.request.urlopen(request, timeout=120) as response, tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as f:
        temporary = Path(f.name)
        try:
            shutil.copyfileobj(response, f)
        except BaseException:
            f.close()
            temporary.unlink(missing_ok=True)
            raise
    try:
        if sha256 and hashlib.sha256(temporary.read_bytes()).hexdigest() != sha256:
            raise ValueError(f"Source has changed; SHA-256 mismatch for {url}")
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    print(target.relative_to(ROOT))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", choices=["pdfs", "census", "all"], default="all")
    args = parser.parse_args()
    if args.only in ("pdfs", "all"):
        manifest = ROOT / "sources" / "report_manifest.csv"
        data = ROOT / "Oneida_County_911_Reports"
        data.mkdir(exist_ok=True)
        with manifest.open(encoding="utf-8", newline="") as f:
            for row in csv.DictReader(f):
                target = (data / row["file"]).resolve()
                if not target.is_relative_to(data.resolve()):
                    raise ValueError("Report path leaves the input directory")
                download(row["source_url"], target, row["sha256"])
        shutil.copyfile(manifest, data / "manifest.csv")
    if args.only in ("census", "all"):
        for layer, stem in LAYERS.items():
            folder = ROOT / "geo" / "tiger" / stem
            required = [folder / (stem + ext) for ext in ([".dbf"] if layer == "FEATNAMES" else [".shp", ".shx", ".dbf"])]
            if all(p.exists() for p in required):
                continue
            archive = ROOT / "geo" / "tiger" / (stem + ".zip")
            download(f"{CENSUS}/geo/tiger/TIGER2024/{layer}/{stem}.zip", archive)
            folder.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(archive) as z:
                if any(not (folder / info.filename).resolve().is_relative_to(folder.resolve()) for info in z.infolist()):
                    raise ValueError("Census archive contains an unsafe path")
                z.extractall(folder)
        download(f"{CENSUS}/programs-surveys/popest/datasets/2020-2024/cities/totals/sub-est2024.csv",
                 ROOT / "geo" / "census" / "sub-est.csv")


if __name__ == "__main__":
    main()

# Oneida County 911 dispatch dataset and map

This project extracts public county media reports, normalizes agency and call-type names, estimates street locations, and builds a static map with filters and analytical panels. A row is an agency dispatch, not necessarily a distinct emergency. The recovered archive covers 386 days across 2024–2026 (364 in 2024, 9 in 2025, 13 in 2026) and is not a continuous time series.

## Rebuild

Use Python 3.13 (the tested environment) and Node.js 24 for browser checks. From the repository root:

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -I scripts/download_inputs.py
python -I extract_raw.py
python -I build_dataset.py
python -I geo/geocode.py
python -I geo/attach_geocodes.py
python -I geo/build_map_data.py
python -I geo/make_map_page.py geo/vendor/leaflet-1.9.4.css
```

On macOS/Linux activate the environment with `source .venv/bin/activate`. Input downloads require network access. Existing inputs are reused; PDFs are checked against the SHA-256 hashes in [sources/report_manifest.csv](sources/report_manifest.csv). A changed or unavailable county source stops restoration with an error instead of silently substituting a different report. To restore only part of the inputs, use `--only pdfs` or `--only census`.

The reference-data downloader restores Census TIGER/Line 2024 county roads, address features, alternate road names and water, plus New York municipality boundaries and landmarks. Population is from the [Census 2024 subcounty estimates](https://www2.census.gov/programs-surveys/popest/datasets/2020-2024/cities/totals/sub-est2024.csv). Inputs and intermediate CSVs are ignored by Git; source metadata and scripts are tracked. Population is optional: without its CSV the map builds with population-rate panels marked unavailable.

`docs/index.html` is the GitHub Pages entry point; `output/map/oneida_911_map.html` is an identical local copy. Both embed their data, Leaflet CSS and Leaflet JavaScript, so the map does not require a CDN. Google Fonts are optional and have system-font fallbacks. Leaflet 1.9.4 is distributed under [its BSD license](geo/vendor/Leaflet-LICENSE.txt).

## Validate

```powershell
python -I -B -m unittest discover -s tests -p "test_*.py" -v
node tests/ui.cjs
python -I -B geo/evaluate_geocoding.py
```

The dataset tests use rebuilt local outputs. Browser tests use a temporary headless Edge profile on Windows; set `BROWSER_PATH` to a Chromium/Chrome/Edge executable on other systems. They check comparisons, incident counts, rate denominators, grouped filters, downloads, shared links, keyboard controls, themes, responsive layout, and absent population data. The geocoding evaluation compares placement methods on intersection examples; these examples are not a representative accuracy sample.

## Interpretation

- Coordinates printed in reports are preserved per dispatch. Missing locations stay unmapped. Named streets that cannot be matched may receive an explicitly approximate municipality point.
- Fuzzy matching rejects conflicting numbers and street types. Modeled expected error describes assumed address/road distributions, not verified distances to actual incidents.
- Incident clusters are a heuristic with a maximum 120-second duration, or five seconds for records with only a municipality. Completely unspecified locations are not merged; coordinates distinguish coordinate-only incidents. Distinct agency counts refer to the complete inferred incident, even when an agency filter is active.
- Population rates are observed dispatches per matching report day, scaled to 365 days and 1,000 residents. Year, date and weekday filters determine the report-day denominator; an hour filter restricts the dispatches counted in each matching day. These are annualized estimates from incomplete coverage, not observed full-year totals.
- Dispatch CSV downloads include every dispatch matching the filters, including mutual aid hidden from the map. Places CSVs describe the currently visible mapped locations. Dispatch exports retain reported streets, coordinates, timestamp precision, agencies and PDF provenance separately from map estimates.

See [output/README.md](output/README.md) for dataset columns.

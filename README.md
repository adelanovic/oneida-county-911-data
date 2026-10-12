# Oneida County 911 dispatch dataset and map

This project extracts public county media reports, normalizes agency and call-type names, estimates street locations, and builds a static map with filters and analytical panels. A row is an agency dispatch, not necessarily a distinct emergency. The recovered archive contains 687 PDFs covering 684 report dates across 2024–2026. The dataset has 421,513 dispatches across 681 days with records (364 in 2024, 194 in 2025, 123 in 2026), and is not a continuous time series. Three published reports are empty; they are preserved in the manifest but excluded from dispatch-day rate denominators because they do not establish that no 911 activity occurred.

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

- The Seasons panel is temporarily commented out, with its implementation preserved in the map template. When enabled, Seasons uses all selected years and updates when new reports are rebuilt into the map. Monthly rates divide dispatches by matching report days, including days with zero matching calls. A table shows rates and report coverage separately for each year; missing months are not treated as zero. Call-type rankings use only year-months with at least 80% coverage and require six comparable calendar months and 150 dispatches. Sparse coverage and the changed 2026 reporting system can distort comparisons. The month filter applies across years; Seasons keeps all months visible for context.
- Identical whole-report copies are counted once, even when the county publishes them under different filenames. Superseded versions are also excluded; all original rows and PDFs remain available for audit.
- Coordinates printed in reports are preserved per dispatch. Missing locations stay unmapped. Named streets that cannot be matched may receive an explicitly approximate municipality point.
- Fuzzy matching rejects conflicting numbers and street types. Modeled expected error describes assumed address/road distributions, not verified distances to actual incidents.
- Incident clusters are a heuristic with a maximum 120-second duration, or five seconds for records with only a municipality. Completely unspecified locations are not merged; coordinates distinguish coordinate-only incidents. Distinct agency counts refer to the complete inferred incident, even when an agency filter is active.
- Population rates are observed dispatches per matching report day, scaled to 365 days and 1,000 residents. Year, month, date and weekday filters determine the report-day denominator; an hour filter restricts the dispatches counted in each matching day. These are annualized estimates from incomplete coverage, not observed full-year totals.
- Dispatch CSV downloads include every dispatch matching the filters, including mutual aid hidden from the map. Places CSVs describe the currently visible mapped locations. Dispatch exports retain reported streets, coordinates, timestamp precision, agencies and PDF provenance separately from map estimates.

See [output/README.md](output/README.md) for dataset columns.

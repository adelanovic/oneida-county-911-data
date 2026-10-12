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

The reference-data downloader restores Census TIGER/Line 2024 county roads, address features, alternate road names and water, plus New York municipality boundaries and landmarks. Selected unmatched Utica, Whitesboro, Marcy, Rome, Verona, Westmoreland, Kirkland and Clinton village locations also use a checked-in snapshot of [Oneida County public CAD road geometry](https://maps.oneidacountyny.gov/arcgis/rest/services/E911_CAD/E911_CAD/MapServer/0). Refresh that reviewed subset explicitly with `python -I -B scripts/refresh_location_reference.py`, or add `--city "WHITESBORO VILLAGE"` for Whitesboro or `--city MARCY` for Marcy (Rome uses `--city "ROME INSIDE"` or `--city "ROME OUTSIDE"`; Verona uses `--city VERONA`; Westmoreland uses `--city WESTMORELAND`; Kirkland and Clinton use `--city KIRKLAND` and `--city "CLINTON VILLAGE"`), then inspect its diff and rerun spatial checks; ordinary builds use the saved file offline. Population is from the [Census 2024 subcounty estimates](https://www2.census.gov/programs-surveys/popest/datasets/2020-2024/cities/totals/sub-est2024.csv). Inputs and intermediate CSVs are ignored by Git; source metadata and scripts are tracked. Population is optional: without its CSV the map builds with population-rate panels marked unavailable.

`docs/index.html` is the GitHub Pages entry point; `output/map/oneida_911_map.html` is an identical local copy. Both embed their data, Leaflet CSS and Leaflet JavaScript, so the map does not require a CDN. Google Fonts are optional and have system-font fallbacks. Leaflet 1.9.4 is distributed under [its BSD license](geo/vendor/Leaflet-LICENSE.txt).

## Validate

```powershell
python -I -B -m unittest discover -s tests -p "test_*.py" -v
node tests/ui.cjs
python -I -B geo/evaluate_geocoding.py
```

The dataset tests use rebuilt local outputs. Browser tests use a temporary headless Edge profile on Windows; set `BROWSER_PATH` to a Chromium/Chrome/Edge executable on other systems. They check comparisons, incident counts, rate denominators, grouped filters, downloads, shared links, keyboard controls, themes, responsive layout, and absent population data. The geocoding evaluation compares placement methods on intersection examples; these examples are not a representative accuracy sample.

## Interpretation

- Information buttons beside chart headings open the detailed definitions and methodology in a keyboard- and touch-accessible dialog. Notes use the current filter state when opened. Short coverage counts, exclusions, unavailable-rate messages and reporting warnings remain visible on the page.
- Compare counts medical dispatches by category and reports Delta/Echo shares only among medical dispatches with a priority code, alongside the count without one. Place comparisons replace the place filter; year comparisons replace year and exact-date filters, with the ignored date disclosed. Year comparisons can use only month/day dates available in both years; weekday filters then apply separately in each year. Monthly coverage is shown separately from activity, and missing-report sides do not draw zero lines. The full-day hourly profile ignores the hour filter, which still applies to summary counts and call mix; hourly values support hover, tap, keyboard inspection and a data table. The 2026 reporting warning remains visible even for small samples.
- The Seasons panel is temporarily commented out, with its implementation preserved in the map template. When enabled, Seasons uses all selected years and updates when new reports are rebuilt into the map. Monthly rates divide dispatches by matching report days, including days with zero matching calls. A table shows rates and report coverage separately for each year; missing months are not treated as zero. Call-type rankings use only year-months with at least 80% coverage and require six comparable calendar months and 150 dispatches. Sparse coverage and the changed 2026 reporting system can distort comparisons. The month filter applies across years; Seasons keeps all months visible for context.
- Response connections link each agency's most-served town (largest dispatch count across all available reports, before filters) to other response towns. Town-center connections are not vehicle journeys, verified station locations, service boundaries, or confirmed mutual aid. Routine coverage can cross town lines, including New York Mills FD's coverage in New Hartford and Whitestown.
- Agency coverage percentages use all known destinations under the time, call-type and responder filters; a place selection only limits which agencies appear. Each agency shows its missing-location count, with a warning when at least 20% are unknown. The list initially shows 12 agencies, can expand to all eligible agencies, and retains the selected agency. Percentages require at least 40 known destinations.
- Identical whole-report copies are counted once, even when the county publishes them under different filenames. Superseded versions are also excluded; all original rows and PDFs remain available for audit.
- Coordinates printed in reports are preserved per dispatch. Missing locations stay unmapped. Named streets that cannot be matched may receive an explicitly approximate municipality point.
- Street matching checks local exact names, ordinals and spelling variants before fuzzy matches, allowing a 200 m boundary tolerance. It does not place an entire out-of-town road network merely because one segment is nearby. Without a known municipality, only short, connected road matches receive a tentative estimate.
- Circles and the busiest-point ranking combine dispatches at the same displayed coordinates. Select a point to see its original reported locations and counts. Unmatched streets share a clearly labeled approximate municipality point. Places downloads include each grouped point's reported-location breakdown; dispatch downloads preserve the individual source fields. Shared point links include coordinates to distinguish coordinate-only locations; ambiguous older links do not select an arbitrary point.
- Address weighting uses house-number ranges as a proxy, rejects segments implying over 1,000 addresses or more than one address per meter, and preserves density when clipping at boundaries. These checks do not turn TIGER ranges into verified address counts. Landmark matches reject related subfacilities such as a resort's heliport and do not claim a measured placement error.
- Fuzzy matching rejects conflicting numbers, street types and ambiguous directional alternatives. Modeled expected error describes assumed address/road distributions, not verified distances to actual incidents.
- Incident clusters are a heuristic with a maximum 120-second duration, or five seconds for records with only a municipality. Completely unspecified locations are not merged; coordinates distinguish coordinate-only incidents. Distinct agency counts refer to the complete inferred incident, even when an agency filter is active.
- Population rates default to observed dispatches per 1,000 residents across the matching covered dates; the comparison table also uses observed-period rates. The county benchmark excludes dispatches without an assigned Oneida County town or city, matching the town ranking's location requirement. The place filter is ignored for the ranking. An optional annual equivalent requires one calendar year with at least 90% of its days and 80% of every month's days covered, and no date, month, weekday or hour filter. It scales by that year's 365 or 366 days divided by covered days. Partial coverage and 2026 reporting changes can affect comparisons. Population uses a fixed 2024 Census vintage, adjusted to reported areas for Waterville, Remsen and Sherrill; affected towns are labeled reporting areas. Village rates count only explicit village labels, which may miss incidents reported under a town alone.
- Dispatch CSV downloads include every dispatch matching the filters, including mutual aid hidden from the map. Places CSVs describe the currently visible mapped locations. Dispatch exports retain reported streets, coordinates, timestamp precision, agencies and PDF provenance separately from map estimates.

See [output/README.md](output/README.md) for dataset columns.

County CAD gap-fill matches use exact names (with direction and common abbreviation normalization), restricted to Utica, Whitesboro village, Marcy, Rome, Verona, Westmoreland, Kirkland or Clinton village and clipped to its boundary plus the same 200 m tolerance. Highway ramps remain distinct from the main road. A short reviewed correction list handles specific misspellings; it does not substitute conflicting road types or infer missing directions. Rome snapshots retain county CAD district labels; clipping uses the Census city boundary, which does not distinguish inside/outside districts. Their points use road-length weighting. Named facility/access features are approximate landmark estimates, with incident accuracy left unknown. Reference geometry is a current snapshot, not a reconstruction of historical street layouts. Original reported locations remain unchanged.

Verona's reviewed Thruway aliases use the county's separate I-90 eastbound, westbound, Exit 33 and parking geometry; the [Thruway Authority exit listing](https://thruway.ny.gov/travelers/interchange-exit-listing) confirms Exit 33 at Verona. Mainline points summarize the matched road stretch inside Verona and can be kilometers from an actual incident. Parking areas, Marion Manor, Turning Stone and Villages at Stoney Creek are approximate facility/access estimates. Generic ramp labels without an exit or direction and ambiguous turnarounds remain at the approximate municipality point.

Westmoreland uses separate county CAD I-90 eastbound, westbound, Exit 32 and named ramp geometry. Stop 7 Road and the reviewed local streets retain their reported numbers and directions. Oneida Service Center and the Thruway service entrance are separate approximate facility/access estimates without incident-accuracy claims. A Thruway ramp label without an exit number or direction remains at the approximate municipality point.

Kirkland and Clinton village use separate reviewed county CAD subsets and reported-area labels. Utica Street is matched separately for each reporting area; Stafford Circle retains north/south qualifiers. New Carriage House Apartments uses an approximate facility/access point and is not substituted for Olde Carriage House Apartments. Clinton's reported W PARK AVE is not assumed to mean the county's WEST PARK ROW. BASSETT remains approximate: the [clinic's published address](https://bassett.org/locations/bassett-health-center-clinton) alone does not establish a verified site coordinate for that name-only dispatch.

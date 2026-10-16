# Oneida County 911 dispatch records — ML dataset

Built from 707 PDFs (public downloads and files supplied by the Oneida County 911 Director) in `../Oneida_County_911_Reports/reports/`.

```
python -I extract_raw.py            # PDFs -> output/raw_records.csv + extraction_log.csv
python -I build_dataset.py          # raw  -> output/oneida_911_records.csv + mapping tables
python -I geo/geocode.py            # street + town -> geo/locations.csv
python -I geo/attach_geocodes.py    # adds geo_* columns to output/oneida_911_records.csv
python -I geo/evaluate_geocoding.py # optional: method comparison + match review
python -I geo/build_map_data.py    # dataset + Census layers -> packed map data
python -I geo/make_map_page.py geo/vendor/leaflet-1.9.4.css # publishable HTML
```

The dispatch data covers 864 days: 366 in 2024, 365 in 2025 and 133 in 2026. Three empty published reports remain in the source manifest; recovered reports now cover their 2025 dispatch dates. Empty reports alone do not establish zero activity.

## Files

| File | Contents |
|---|---|
| `oneida_911_records.csv` | **Main dataset.** 506,461 rows, one per agency dispatch. |
| `raw_records.csv` | Cell text exactly as extracted (line breaks kept), 507,832 rows including superseded report versions and duplicate report copies. |
| `extraction_log.csv` | Per-PDF row count vs. the total printed in the report. All 707 reconcile to printed totals or agency subtotals; three reports are empty. |
| `response_type_map.csv` | Raw response type → harmonized `response_type` + `category`, with counts. |
| `agency_map.csv` | Raw agency name → canonical `agency` + `agency_type`, with counts. |

## Columns in `oneida_911_records.csv`

| Column | Description |
|---|---|
| `record_id` | Row id (sorted by call time). |
| `call_datetime` | `YYYY-MM-DD HH:MM:SS`. New-format reports from July 15, 2025 give minutes only, so seconds are `00`. |
| `time_precision` | `second` (format A) or `minute` (format B, starting July 15, 2025). |
| `year` `month` `day` `hour` `minute` | Calendar parts of the call time. |
| `day_of_week` `day_name` `is_weekend` | 0 = Monday. |
| `week_of_year` `day_of_year` | ISO week; day 1–366. |
| `hour_sin` `hour_cos` | Cyclical encoding of the time of day. |
| `agency` | Canonical agency name, unified across both report formats. |
| `agency_type` | `LOCAL_POLICE`, `SHERIFF`, `STATE_POLICE`, `CAMPUS_POLICE`, `FIRE`, `EMS`, `OTHER_911_CENTER`, `OTHER`. |
| `category` | Broad call category (13 classes): `MEDICAL`, `TRAFFIC`, `WELFARE_ASSIST`, `DOMESTIC_DISPUTE`, `ADMIN_PROACTIVE`, `PROPERTY_CRIME`, `PUBLIC_ORDER`, `ALARM`, `FIRE_HAZARD`, `MENTAL_HEALTH`, `CALL_ISSUE`, `ANIMAL`, `VIOLENT_CRIME`. |
| `response_type` | Harmonized call type. New-format wording is mapped to the older wording (e.g. `SUSPICIOUS ACTIVITY` → `SUSP ACTIVITY`), and the `IN PROGRESS` suffix is moved to `in_progress`. |
| `in_progress` | The call type said "IN PROGRESS". Only the older system uses this suffix. |
| `is_mpds` | The call type is a Medical Priority Dispatch System code. |
| `mpds_code` | e.g. `26A09`. |
| `mpds_protocol` `mpds_protocol_name` | Protocol 1–37 (e.g. 26 = SICK PERSON). |
| `mpds_level` `mpds_level_rank` | Determinant level `O/A/B/C/D/E`, ranked 0–5 (higher = more urgent). |
| `mpds_description` | Text after the code. |
| `street` | Street or block name (the reports print no house numbers). The new-format spelling is converted to older style: `NORTH`→`N`, `SAINT`→`ST`, `STATE ROUTE`→`ROUTE`. |
| `is_intersection` | The street contains ` / `. |
| `city` | Normalized reported city, town or village code, including reviewed truncation/typo corrections. |
| `city_raw` | Repaired source municipality text before code corrections; retained for provenance. |
| `town` | The city (Utica, Rome, Sherrill) or town the call is in. Villages roll up to the town that contains them (Whitesboro → `WHITESTOWN`), and Rome Inside/Outside both become `ROME`. Use this for town-level grouping. |
| `village` | The village within the town, if any (e.g. `WHITESBORO`). New York Mills straddles two towns; the dispatch code records which part. |
| `district` | Sub-area qualifier: `INSIDE`/`OUTSIDE` (Rome's inner and outer districts), `HINCKLEY` (Trenton). |
| `county` | `ONEIDA`, a reported neighboring county, or blank when unknown. A neighboring-county location alone does not establish mutual aid. |
| `outside_county` | True when the reported location is assigned to a county other than Oneida. |
| `latitude` `longitude` | Coordinates printed in the source report. Preserved individually in the geocoded columns, map data and dispatch downloads. |
| `location_missing` | No reported street and no reported coordinates. These dispatches stay unmapped. |
| `geo_latitude` `geo_longitude` | Estimated point from Census TIGER/Line 2024, a saved county CAD road-reference subset for Utica, Whitesboro, Marcy, Rome, Verona, Westmoreland, Kirkland, Clinton village and Camden village gaps, or the original reported coordinates. Matched streets are clipped to the reported municipality with a 200 m boundary tolerance. Plausible house-number ranges guide placement; they are not verified address counts. |
| `geo_precision` | `street`, `municipality` (unmatched street placed at an approximate municipality point), `intersection`, `street_nearby` (tentative short-road match without a known municipality), `landmark`, `coordinates`, or `none` (missing or unresolved location). |
| `geo_match_method` | `exact`, `alias`, `reviewed_alias` (a specific reported-name correction), `ordinal`, `spelling`, `fuzzy`, `county_roads` (exact county CAD name, scoped to reviewed municipalities), `county_roads_alias` (explicit reviewed name correction), `reported`, `intersection`, `landmark`, or `municipality`; blank if unresolved. Conflicting numbers, street types and ambiguous directional fuzzy matches are rejected. |
| `geo_expected_error_m` | Modeled expected distance under an assumed distribution of address ranges/road lengths. This is not a measured distance to the incident or a validated accuracy probability. Long roads can have several km of uncertainty. Blank for landmark estimates, including county CAD apartment/access features, because facility geometry does not establish incident accuracy. County road estimates use road-length weighting. |
| `incident_cluster_id` | Heuristic group with the same type and reported place, bounded to 120 s from its first row (5 s for municipality-only records). Coordinates distinguish coordinate-only locations. Completely unspecified locations are not merged. |
| `agencies_in_cluster` | Number of distinct agencies in that cluster. |
| `agency_raw` `response_type_raw` `location_raw` | Cleaned text before normalization, for auditing. |
| `report_date` `report_format` `report_version` `source_file` `page` `row_in_file` | Source provenance. `report_date` is the nominal file date (first covered date for supplied monthly PDFs); use `call_datetime` for dispatch-date analysis. Format `A` = "Media Summary Report" through the morning of July 15, 2025; format `B` = "Oneida County Media Report" from that day. July's combined PDF retains its original June folder path; dispatch timestamps determine July coverage. |

## Caveats for modeling

- **Map points aggregate dispatches, not incidents.** The map combines matching dispatches at identical displayed coordinates and shows the original reported-location breakdown when selected. This includes a single approximate municipality point for unmatched streets. Dispatch exports preserve individual source fields; places exports contain point totals and their grouped-location breakdowns.
- **Rows are agency dispatches, not unique emergencies.** One crash can produce 4 rows (ambulance, fire, state police, sheriff). Deduplicate on `incident_cluster_id` when you count incidents.
- **Coverage has gaps:** 366 days with records in 2024, 365 in 2025, and 133 in 2026. Don't treat this as a continuous time series without accounting for missing and empty reports; the map coverage calendar uses distinct dispatch dates.
- **The CAD system changed on July 15, 2025:** coarser timestamps, omitted traffic stops and premise checks, and partly different call-type wording. Full 2025 calendar coverage spans two reporting regimes. Include `report_format` as a feature or control for it.
- Call types are what dispatch recorded at intake, not confirmed outcomes. There are no arrival or clear times, so response times can't be computed.
- `September-24-2026` and `September-25-2026` each had a `-v2` reissue. Only the v2 rows are kept (931 v1 rows dropped).

Location matching preserves ramp, exit and travel-direction qualifiers. Reviewed county road snapshots cover 45 reporting areas; town and village subsets remain distinct. Unknown place codes do not default to Oneida County. The map flags separate matching road stretches as ambiguous; dispatch downloads include the original municipality label, matched reference name and stretch count. Coordinate parsing accepts complete valid pairs using tilde or comma separators, including wrapped decimal digits.

The reviewed July 15 Rome Police alarm dispatch appears in both systems and is counted once. Ten unmatched old-format dispatches after 09:14 remain, including nine proactive State Police dispatches and a separate Sheriff alarm response. Exclusion is based on the reviewed corresponding dispatch, not a blanket time cutoff.

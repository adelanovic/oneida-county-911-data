# Oneida County 911 dispatch records — ML dataset

Built from the 280 public PDFs in `../Oneida_County_911_Reports/reports/`.

```
python -I extract_raw.py            # PDFs -> output/raw_records.csv + extraction_log.csv
python -I build_dataset.py          # raw  -> output/oneida_911_records.csv + mapping tables
python -I geo/geocode.py            # street + town -> geo/locations.csv
python -I geo/attach_geocodes.py    # adds geo_* columns to output/oneida_911_records.csv
python -I geo/evaluate_geocoding.py # optional: method comparison + match review
python -I geo/build_map_data.py    # dataset + Census layers -> packed map data
python -I geo/make_map_page.py geo/vendor/leaflet-1.9.4.css # publishable HTML
```

## Files

| File | Contents |
|---|---|
| `oneida_911_records.csv` | **Main dataset.** 181,601 rows, one per agency dispatch. |
| `raw_records.csv` | Cell text exactly as extracted (line breaks kept), 182,532 rows including superseded report versions. |
| `extraction_log.csv` | Per-PDF row count vs. the total printed in the report. All 280 match. |
| `response_type_map.csv` | Raw response type → harmonized `response_type` + `category`, with counts. |
| `agency_map.csv` | Raw agency name → canonical `agency` + `agency_type`, with counts. |

## Columns in `oneida_911_records.csv`

| Column | Description |
|---|---|
| `record_id` | Row id (sorted by call time). |
| `call_datetime` | `YYYY-MM-DD HH:MM:SS`. 2026 reports give minutes only, so seconds are `00`. |
| `time_precision` | `second` (2024–25 reports) or `minute` (2026 reports). |
| `year` `month` `day` `hour` `minute` | Calendar parts of the call time. |
| `day_of_week` `day_name` `is_weekend` | 0 = Monday. |
| `week_of_year` `day_of_year` | ISO week; day 1–366. |
| `hour_sin` `hour_cos` | Cyclical encoding of the time of day. |
| `agency` | Canonical agency name, unified across both report formats. |
| `agency_type` | `LOCAL_POLICE`, `SHERIFF`, `STATE_POLICE`, `CAMPUS_POLICE`, `FIRE`, `EMS`, `OTHER_911_CENTER`, `OTHER`. |
| `category` | Broad call category (13 classes): `MEDICAL`, `TRAFFIC`, `WELFARE_ASSIST`, `DOMESTIC_DISPUTE`, `ADMIN_PROACTIVE`, `PROPERTY_CRIME`, `PUBLIC_ORDER`, `ALARM`, `FIRE_HAZARD`, `MENTAL_HEALTH`, `CALL_ISSUE`, `ANIMAL`, `VIOLENT_CRIME`. |
| `response_type` | Harmonized call type. 2026 wording is mapped to the 2024–25 wording (e.g. `SUSPICIOUS ACTIVITY` → `SUSP ACTIVITY`), and the `IN PROGRESS` suffix is moved to `in_progress`. |
| `in_progress` | The call type said "IN PROGRESS". Only the 2024–25 system uses this suffix. |
| `is_mpds` | The call type is a Medical Priority Dispatch System code. |
| `mpds_code` | e.g. `26A09`. |
| `mpds_protocol` `mpds_protocol_name` | Protocol 1–37 (e.g. 26 = SICK PERSON). |
| `mpds_level` `mpds_level_rank` | Determinant level `O/A/B/C/D/E`, ranked 0–5 (higher = more urgent). |
| `mpds_description` | Text after the code. |
| `street` | Street or block name (the reports print no house numbers). The 2026 spelling is converted to 2024–25 style: `NORTH`→`N`, `SAINT`→`ST`, `STATE ROUTE`→`ROUTE`. |
| `is_intersection` | The street contains ` / `. |
| `city` | City, town or village code as printed (e.g. `ROME INSIDE`, `YORKVILLE VILLAGE`). |
| `town` | The city (Utica, Rome, Sherrill) or town the call is in. Villages roll up to the town that contains them (Whitesboro → `WHITESTOWN`), and Rome Inside/Outside both become `ROME`. Use this for town-level grouping. |
| `village` | The village within the town, if any (e.g. `WHITESBORO`). New York Mills straddles two towns; the dispatch code records which part. |
| `district` | Sub-area qualifier: `INSIDE`/`OUTSIDE` (Rome's inner and outer districts), `HINCKLEY` (Trenton). |
| `county` | `ONEIDA`, or the neighboring county for the few mutual-aid calls (Herkimer, Oswego, Madison, Lewis). |
| `outside_county` | True for those 15 mutual-aid calls. |
| `latitude` `longitude` | Present when a 2026 report printed coordinates in place of a street (33 retained rows). Preserved individually in the geocoded columns and map. |
| `location_missing` | No street and no coordinates (about 16%; mostly traffic stops and some police calls). |
| `geo_latitude` `geo_longitude` | Estimated point for the street within its town, from `geo/geocode.py` (Census TIGER/Line 2024). The point sits where the street's addresses are concentrated. |
| `geo_precision` | `street` (80%), `municipality` (3%, street not found, so the town center is used), `intersection`, `street_nearby`, `landmark`, `coordinates`, `none` (16%, no location in the report). |
| `geo_match_method` | How the street name was matched: `exact`, `ordinal`, `spelling` (punctuation or abbreviation only), `fuzzy`, `fuzzy_risky` (street type or number differs; treat with care), `landmark`, `municipality`. |
| `geo_expected_error_m` | Modeled expected distance under an assumed distribution of addresses/road lengths. This is not a measured distance to the incident or a validated accuracy probability. Long roads can have several km of uncertainty. |
| `incident_cluster_id` | Heuristic group with the same type and reported place, bounded to 120 s from its first row (5 s for municipality-only records). Coordinates distinguish coordinate-only locations. Completely unspecified locations are not merged. |
| `agencies_in_cluster` | Number of distinct agencies in that cluster. |
| `agency_raw` `response_type_raw` `location_raw` | Cleaned text before normalization, for auditing. |
| `report_date` `report_format` `report_version` `source_file` `page` `row_in_file` | Where the row came from. Format `A` = 2024–25 "Media Summary Report"; format `B` = 2026 "Oneida County Media Report". |

## Caveats for modeling

- **Rows are agency dispatches, not unique emergencies.** One crash can produce 4 rows (ambulance, fire, state police, sheriff). Deduplicate on `incident_cluster_id` when you count incidents.
- **Coverage has gaps:** 257 days in 2024 (Jan–Sep), 8 days in 2025, and 13 days in 2026. Don't treat this as a continuous time series without accounting for missing days (see `../Oneida_County_911_Reports/coverage.csv`).
- **The CAD system changed in 2026:** coarser timestamps and partly different call-type wording. Include `report_format` as a feature or control for it.
- Call types are what dispatch recorded at intake, not confirmed outcomes. There are no arrival or clear times, so response times can't be computed.
- `September-24-2026` and `September-25-2026` each had a `-v2` reissue. Only the v2 rows are kept (931 v1 rows dropped).

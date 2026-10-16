# Code and new-report audit — October 16, 2026

Implementation follow-up: the four findings below are the original audit snapshot. The tracked manifest now retains all 707 PDFs, monthly date descriptions reflect dispatch timestamps, and extraction checks manifest consistency. The cutover exclusion now requires the single reviewed Rome Police counterpart, restoring ten dispatches (506,461 total). Map reporting warnings use per-date report-format metadata, including late 2025, and dataset documentation has been refreshed. Regression checks cover source retention, monthly date/format metadata, and preservation of unmatched cutover dispatches. See the implementation turn's validation results for the final checks.

Final implementation validation: input restoration passed with all 707 manifest entries retained. The rebuilt dataset and both HTML copies contain 506,461 dispatches over 864 covered dates. All 59 tests in the Python suite passed; the subsequently added manifest-mismatch test also passed (60 distinct Python checks). The full browser suite passed, including new late-2025 warning checks, comparisons, population rates, exports, replay, accessibility, responsive layouts, and missing optional population data. The earlier Edge startup limitation was resolved on the implementation run.

This review covers extraction, normalization and exclusion rules, geocode attachment, packed map data, map filters and reporting warnings, rebuild inputs, and regression tests. Application code and published data were left unchanged by this review. The working tree was already modified, and `tests/ui.cjs` changed again during the review; the findings below distinguish that concurrent correction.

## Findings requiring changes

### 1. High: restoring inputs silently removes the new reports from subsequent extraction

**References:** `scripts/download_inputs.py:52`, `scripts/download_inputs.py:67`, `extract_raw.py:153`, `sources/report_manifest.csv`.

The tracked manifest contains 687 PDFs, while the local manifest contains 707. The missing 20 entries include all six combined 2025 reports, four recovered daily reports, and October 3–12, 2026. The documented rebuild first runs the downloader, which overwrites the 707-entry local manifest with the 687-entry tracked manifest. Extraction reads only that overwritten manifest. The files can still exist on disk and nevertheless be omitted from the rebuilt map.

The no-public-URL handling recently added to the downloader is appropriate, but none of the new supplied PDFs is registered in the tracked manifest, so that branch cannot restore or validate them in the documented workflow.

**Suggested correction:** register all 707 sources in the tracked manifest, retaining hashes and explicit private-supply provenance for files without a public URL. Require supplied files to be present, as the new downloader branch already does. Add a manifest-consistency check before extraction or publication.

### 2. High: the cutover rule deletes ten dispatches absent from the replacement report

**Reference:** `build_dataset.py:376–384`.

The earliest format-B timestamp on July 15, 2025 is 09:14. The new cutoff deletes every format-A row at or after that time: 11 rows, numbered 155–165 on page 5 of the old July 15 report. Nine are State Police traffic stops or premise checks. The new July report contains neither of those call types. Another is the Sheriff's Office alarm dispatch at 09:21:49 to E BLOOMFIELD ST; there is no Sheriff dispatch in the new report during that interval. Only the Rome Police alarm dispatch has a corresponding replacement, at 09:22 in format B.

The deleted records therefore cannot all be called duplicate overlap. Their loss affects dispatch totals, agency counts, and the incident's distinct-agency count. The same generic rule would also discard valid old-format rows on any future day shared by the two formats.

**Suggested correction:** retain old-format rows unless a reviewed corresponding dispatch exists in the other report. Match agency, call type, location and timestamp precision, preserving repeated records and different agencies. For this one transition, an explicit reviewed overlap exception is safer than a blanket time cutoff. Add a regression retaining the nine proactive dispatches and the Sheriff response while removing the matching Rome response once.

### 3. High: reporting-system warnings omit the second half of 2025

**References:** `geo/map_template.html:756`, `geo/map_template.html:1697`, `geo/map_template.html:2052`, `geo/map_template.html:2163`, `geo/map_template.html:2867`.

Format B starts on July 15, 2025, rather than January 2026. All six combined PDFs use it: 77,951 minute-precision dispatches, with zero `TRAFFIC STOP` or premise-check rows. The About text says all 2024–2025 reports use the old system. Warning visibility uses a 2026 year check in the main dashboard, population panels, comparisons and Surge review.

Selecting 2025 alone consequently suppresses warnings despite a reporting discontinuity inside that year. Complete date coverage also makes 2025 eligible for annual population comparisons, which now combine two reporting regimes without the relevant warning. A decline in proactive police activity can be misread as a change in activity rather than report contents.

**Suggested correction:** carry report format or explicit reporting-regime metadata into the packed map data, derive warnings from the dates/regimes actually included, and explain the July 15 transition. Keep calendar coverage and comparability as separate concepts. Update the retained, disabled story logic at line 2748 before enabling it; it also assumes only 2026 lacks the omitted call types.

### 4. Medium: published documentation still describes the old dataset and date semantics

**References:** `README.md:3`, `output/README.md:3`, `output/README.md:15`, `output/README.md:21`, `output/README.md:32`, `output/README.md:66`, `output/README.md:73`.

Documentation still gives 421,513 records and 681 covered days. Current artifacts contain 506,451 records and 864 dates: 366 in 2024, 365 in 2025 and 133 in 2026. Raw extraction contains 507,832 rows. Claims that format B and minute precision start in 2026 are also stale.

For a combined report, `report_date` is the manifest's nominal file date, not each dispatch's date. There are 75,233 monthly-report rows where those dates differ. This is acceptable provenance, but the schema should explicitly direct analytical consumers to `call_datetime`. The July PDF is also stored under `reports/2025/06/`, which should be explained or corrected consistently in the manifest and provenance.

**Suggested correction:** refresh counts and source descriptions, document supplied reports separately from public downloads, and document nominal report dates versus dispatch dates. Generate summary counts during the build to reduce drift.

## Verified behavior

- All 707 local PDFs match the SHA-256 hashes in the local manifest.
- All 707 extraction-log totals match parsed rows, with no logged extraction issues.
- All six combined PDFs were independently re-extracted. Every cached row and source field matched the fresh extraction. Timestamp-anchor counts and independently summed agency-header totals also matched each PDF's printed grand total.
- July's combined PDF covers July 15–31; the other five cover every date in their named months. Their row counts are July 7,942; August 14,227; September 14,016; October 13,984; November 13,029; December 14,753.
- The map derives dates and coverage from `call_datetime`, so the combined PDFs do not collapse into a single day in the current map.
- All 54 Python regression tests pass, including source-field packing, coordinate preservation, geocode boundary checks, report-alias handling and equality of the two published HTML copies.

## Test correction observed during review and validation limits

At the start of this review, `tests/ui.cjs:88` used `report_date` for weekday medical expectations and seasonal coverage. That was incorrect for monthly PDFs. While this review was running, another process changed it to the dispatch date and replaced the stale hardcoded 364-day assertion with a computed count. Those edits were preserved. A standalone run of the current expected-count calculation reports all calendar days for each month of 2025.

The full browser suite was attempted twice, including outside the sandbox, but Edge did not expose its debugging endpoint and the runner stopped before page assertions. Browser interaction remains unverified in this review. Passing Python tests do not cover the cutover data loss or reporting-warning visibility. Geocode checks validate consistency and configured boundaries; they cannot establish the true incident location from a street-only report.

"""Step 1: extract every table row from the Oneida County 911 PDFs into raw_records.csv.

Two report layouts exist:
  A  "Media Summary Report" (Positron CAD, 2024-2025): Date/Time | Agency | Response Type | Location | City
     timestamps to the second, rows in chronological order, total in "Number of Responses: N".
  B  "Oneida County Media Report" (2026): Call Date/Time | Agency | Incident Type | Location Street Name | Location Venue
     timestamps to the minute, rows grouped under "Agency: NAME (N)" headers, total in "Total Records : N".

Words are assigned to columns by x position and to rows by y position, anchored on the date in column 1.
"""
import csv
import re
import sys
from pathlib import Path

import pymupdf

ROOT = Path(__file__).parent
DATA = ROOT / "Oneida_County_911_Reports"
OUT = ROOT / "output"

DATE_RE = re.compile(r"^\d{2}/\d{2}/\d{4}$")
TIME_RE = re.compile(r"^\d{2}:\d{2}(:\d{2})?$")

# Left edge of each column (x0 of a word >= edge puts it in that column or later).
COLUMNS = {
    "A": [("datetime", 0), ("agency", 110), ("response_type", 228), ("location", 334), ("city", 494)],
    "B": [("datetime", 0), ("agency", 105), ("response_type", 178), ("location", 250), ("city", 322)],
}
FIELDS = [c for c, _ in COLUMNS["A"]]


def column_of(fmt, x0):
    name = COLUMNS[fmt][0][0]
    for col, edge in COLUMNS[fmt]:
        if x0 >= edge - 0.5:
            name = col
    return name


def cell_text(words):
    """Join words in reading order; each visual line separated by a newline marker."""
    lines = {}
    for w in words:
        lines.setdefault(round(w[1]), []).append(w)
    out = []
    for y in sorted(lines):
        out.append(" ".join(w[4] for w in sorted(lines[y], key=lambda w: w[0])))
    return "\n".join(out)


def detect_format(doc):
    text = doc[0].get_text()
    if "Media Summary Report" in text:
        return "A"
    if "Oneida County Media Report" in text:
        return "B"
    raise ValueError("unknown report layout")


def stated_total(doc, fmt):
    text = doc[0].get_text()
    pat = r"Number of Responses:\s*([\d,]+)" if fmt == "A" else r"Total Records\s*:\s*([\d,]+)"
    m = re.search(pat, text)
    return int(m.group(1).replace(",", "")) if m else None


def parse_file(path):
    doc = pymupdf.open(path)
    fmt = detect_format(doc)
    rows, agency_groups, issues = [], [], []
    current_group = None
    for pno, page in enumerate(doc):
        words = page.get_text("words")
        header = [w for w in words if w[4] == "Date/Time"]
        footer = [w for w in words if w[4] == "Page" and w[1] > 600]
        if not header:
            # Some Positron continuation pages omit the header and start with a dispatch.
            # Require a date/time pair in the timestamp column before accepting the page.
            continuation = fmt == "A" and pno > 0 and any(
                DATE_RE.match(w[4]) and w[0] < 50 and any(
                    TIME_RE.match(t[4]) and 50 <= t[0] < 110 and abs(t[1] - w[1]) < 1.5
                    for t in words) for w in words)
            if not continuation:
                issues.append(f"page {pno + 1}: no table header")
                continue
            top = 0
        else:
            top = max(w[3] for w in words if abs(w[1] - header[0][1]) < 15) + 0.5  # bottom of the header block
        bottom = min(w[1] for w in footer) - 0.5 if footer else page.rect.height
        body = [w for w in words if w[1] >= top and w[1] < bottom]

        # Agency group headers (format B): "Agency: NAME (N)" starting in the date column.
        group_lines = []
        if fmt == "B":
            for w in body:
                if w[4] == "Agency:" and w[0] < 60:
                    line = sorted([v for v in body if abs(v[1] - w[1]) < 1.5], key=lambda v: v[0])
                    label = " ".join(v[4] for v in line)
                    m = re.match(r"Agency:\s*(.*?)\s*\((\d+)\)$", label)
                    group_lines.append((w[1], m.group(1) if m else label, int(m.group(2)) if m else None))
            group_ys = {round(g[0], 1) for g in group_lines}
            body = [w for w in body if not any(abs(w[1] - gy) < 1.5 for gy in group_ys)]

        anchors = sorted({round(w[1], 1) for w in body if DATE_RE.match(w[4]) and w[0] < 100})
        events = sorted([(y, "row", None) for y in anchors] + [(g[0], "group", g) for g in group_lines],
                        key=lambda e: e[0])

        # Words above the first anchor that are not group headers continue the previous page's last row.
        first_y = events[0][0] if events else bottom
        spill = [w for w in body if w[1] < first_y - 1]
        if spill:
            if rows:
                prev = rows[-1]
                for w in spill:
                    col = column_of(fmt, w[0])
                    prev["_words"][col].append((w[0], w[1] + 10000 * (pno + 1), w[2], w[3], w[4]))
                issues.append(f"page {pno + 1}: {len(spill)} words continued from previous page")
            else:
                issues.append(f"page {pno + 1}: {len(spill)} orphan words before first row")

        for i, (y, kind, g) in enumerate(events):
            if kind == "group":
                current_group = {"name": g[1], "stated": g[2], "count": 0}
                agency_groups.append(current_group)
                continue
            y_next = events[i + 1][0] if i + 1 < len(events) else bottom
            band = [w for w in body if y - 1 <= w[1] < y_next - 1]
            cells = {c: [] for c in FIELDS}
            for w in band:
                cells[column_of(fmt, w[0])].append(w)
            rows.append({"_words": cells, "page": pno + 1, "group": current_group["name"] if current_group else ""})
            if current_group:
                current_group["count"] += 1

    out = []
    for r in rows:
        rec = {c: cell_text(r["_words"][c]) for c in FIELDS}
        rec["page"] = r["page"]
        rec["agency_group"] = r["group"]
        out.append(rec)
    total = stated_total(doc, fmt)
    if total is None and agency_groups:  # some 2026 reports omit the grand total
        total = sum(g["stated"] or 0 for g in agency_groups)
    for g in agency_groups:
        if g["stated"] is not None and g["stated"] != g["count"]:
            issues.append(f"agency group {g['name']}: stated {g['stated']} parsed {g['count']}")
    return fmt, out, total, issues


def main():
    OUT.mkdir(exist_ok=True)
    with open(DATA / "manifest.csv", newline="", encoding="utf-8") as f:
        manifest = list(csv.DictReader(f))

    raw_fields = ["source_file", "report_date", "report_format", "page", "row_in_file", "agency_group"] + FIELDS
    file_fields = ["source_file", "report_date", "report_format", "pages", "stated_total", "parsed_rows",
                   "count_match", "issues"]
    with open(OUT / "raw_records.csv", "w", newline="", encoding="utf-8") as fr, \
         open(OUT / "extraction_log.csv", "w", newline="", encoding="utf-8") as fl:
        rw = csv.DictWriter(fr, raw_fields)
        lw = csv.DictWriter(fl, file_fields)
        rw.writeheader()
        lw.writeheader()
        n_total = 0
        for m in manifest:
            path = DATA / m["file"]
            fmt, recs, total, issues = parse_file(path)
            for i, rec in enumerate(recs, 1):
                rw.writerow({"source_file": m["file"], "report_date": m["report_date"], "report_format": fmt,
                             "row_in_file": i, **rec})
            n_total += len(recs)
            lw.writerow({"source_file": m["file"], "report_date": m["report_date"], "report_format": fmt,
                         "pages": m["pages"], "stated_total": total, "parsed_rows": len(recs),
                         "count_match": total == len(recs), "issues": "; ".join(issues)})
            if total != len(recs) or issues:
                print(f"{m['file']}: stated={total} parsed={len(recs)} {'; '.join(issues)}", file=sys.stderr)
    print(f"files={len(manifest)} rows={n_total}")


if __name__ == "__main__":
    main()

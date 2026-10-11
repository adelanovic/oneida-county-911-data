"""Step 2: clean output/raw_records.csv into an ML-ready dataset.

Outputs (in output/):
  oneida_911_records.csv   one row per agency dispatch, superseded report versions removed
  response_type_map.csv    every cleaned response type -> harmonized type + category, with counts
  agency_map.csv           every raw agency name -> canonical agency + agency type, with counts
"""
import re
from collections import Counter
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).parent
OUT = ROOT / "output"

# ---------------------------------------------------------------------------------------------
# Line-wrap repair. Cells keep "\n" between visual lines; narrow columns sometimes break a word in
# the middle ("HEMORRHAGE/LACERATI" + "ON"). A vocabulary built from words that never touch a line
# break decides whether a break should be closed up or turned into a space.

SPLIT = re.compile(r"[\s\-/()~,]+")

# MPDS (Medical Priority Dispatch System) protocol names; also seeds the vocabulary.
MPDS_PROTOCOLS = {
    1: "ABDOMINAL PAIN", 2: "ALLERGIES/ENVENOMATIONS", 3: "ANIMAL BITES/ATTACKS", 4: "ASSAULT/SEXUAL ASSAULT",
    5: "BACK PAIN", 6: "BREATHING PROBLEMS", 7: "BURNS/EXPLOSION", 8: "CARBON MONOXIDE/INHALATION/HAZMAT",
    9: "CARDIAC/RESPIRATORY ARREST", 10: "CHEST PAIN", 11: "CHOKING", 12: "CONVULSIONS/SEIZURES",
    13: "DIABETIC PROBLEMS", 14: "DROWNING/DIVING", 15: "ELECTROCUTION/LIGHTNING", 16: "EYE PROBLEMS/INJURIES",
    17: "FALLS", 18: "HEADACHE", 19: "HEART PROBLEMS", 20: "HEAT/COLD EXPOSURE", 21: "HEMORRHAGE/LACERATIONS",
    22: "INACCESSIBLE INCIDENT/ENTRAPMENT", 23: "OVERDOSE/POISONING", 24: "PREGNANCY/CHILDBIRTH",
    25: "PSYCHIATRIC/SUICIDE ATTEMPT", 26: "SICK PERSON", 27: "STAB/GUNSHOT/PENETRATING TRAUMA",
    28: "STROKE", 29: "TRAFFIC/TRANSPORTATION INCIDENT", 30: "TRAUMATIC INJURIES", 31: "UNCONSCIOUS/FAINTING",
    32: "UNKNOWN PROBLEM", 33: "INTERFACILITY TRANSFER", 34: "AUTOMATIC CRASH NOTIFICATION",
    35: "HEALTHCARE PRACTITIONER REFERRAL", 36: "PANDEMIC/EPIDEMIC", 37: "INTERFACILITY EVALUATION/TRANSFER",
}
EXTRA_WORDS = ("LACERATION LACERATIONS PEDESTRIAN WESTMORELAND HEMORRHAGE UNCONSCIOUS FAINTING CONVULSIONS SEIZURES "
               "SEXUAL ENVENOMATION ENVENOMATIONS BIRTH PSYCHIATRIC CARDIAC RESPIRATORY")


def build_vocab(series_list):
    """Count word fragments, skipping only the fragment that touches a line break (it may be half a word)."""
    vocab = Counter()
    for s in series_list:
        for cell in s:
            lines = cell.split("\n")
            for i, line in enumerate(lines):
                parts = [p for p in SPLIT.split(line) if p]
                if i < len(lines) - 1 and parts and not re.search(r"[\-/(]$", line):
                    parts = parts[:-1]
                if i > 0 and parts and not re.match(r"^[\-/)]", line):
                    parts = parts[1:]
                vocab.update(parts)
    for w in " ".join(MPDS_PROTOCOLS.values()).split() + EXTRA_WORDS.split():
        vocab.update({p: 5 for p in SPLIT.split(w) if p})
    return vocab


def join_lines(cell, vocab):
    lines = [l.strip() for l in cell.split("\n") if l.strip()]
    if not lines:
        return ""
    out = lines[0]
    for nxt in lines[1:]:
        left = re.split(r"[\-/(]", out.split()[-1])[-1]
        right = re.split(r"[\-/)]", nxt.split()[0])[0]
        joined = left + right
        if out.endswith(("-", "/")):
            out += nxt
        elif left and right and vocab[joined] >= 2 and (vocab[left] == 0 or vocab[right] == 0):
            out += nxt
        else:
            out += " " + nxt
    return re.sub(r"\s+", " ", out).strip()


# ---------------------------------------------------------------------------------------------
# Agencies

AGENCY_SPECIAL = {
    "ONEIDA COUNTY SHERIFFS OFFICE": "Oneida County Sheriff's Office",
    "ONEIDA COUNTY SHERIFF'S OFFICE": "Oneida County Sheriff's Office",
    "NY STATE POLICE": "New York State Police",
    "NEW YORK STATE POLICE ONEIDA": "New York State Police",
    "COCVAC": "COCVAC Ambulance",
    "NY STATE ENCON POLICE": "NYS Environmental Conservation Police",
    "NY MILLS FD": "New York Mills Fire Department",
    "SHERRILL FD": "Sherrill-Kenwood Fire Department",
    "SHERRILL - KENWOOD FIRE DEPT": "Sherrill-Kenwood Fire Department",
    "MAYNARD FD NOTIF": "Maynard Fire Department (Notification)",
    "OC EMERGENCY SERVICES": "Oneida County Emergency Services",
    "SPCA": "SPCA",
    "UTICA UNIVERSITY EMS": "Utica University EMS",
    "ONEIDA INDIAN NATION POLICE": "Oneida Indian Nation Police",
}
AGENCY_PREFIX = {  # format B truncates long names
    "CENTRAL ONEIDA COUNTY VOLUNTEER": "COCVAC Ambulance",
    "NYS ENVIRONMENTAL CONSERVATION": "NYS Environmental Conservation Police",
    "ONEIDA COUNTY AIRPORT FIRE": "Oneida County Airport Fire Department",
}


def canon_agency(raw):
    n = re.sub(r"\s+", " ", raw).strip().upper()
    if n in AGENCY_SPECIAL:
        return AGENCY_SPECIAL[n]
    for p, v in AGENCY_PREFIX.items():
        if n.startswith(p):
            return v
    n = re.sub(r" FD$", " FIRE DEPARTMENT", n)
    n = re.sub(r" FIRE DEPT$", " FIRE DEPARTMENT", n)
    n = re.sub(r" AMB$", " AMBULANCE", n)
    n = re.sub(r" (TOWN|VILLAGE|CITY) POLICE DEPARTMENT$", " POLICE DEPARTMENT", n)
    t = n.title().replace("Mcconnellsville", "McConnellsville").replace("Amcare", "AmCare")
    return t.replace(" 911", " 911")


def agency_type(canon):
    u = canon.upper()
    if "SHERIFF" in u:
        return "SHERIFF"
    if "STATE POLICE" in u or "ENVIRONMENTAL CONSERVATION" in u or "FOREST RANGER" in u:
        return "STATE_POLICE"
    if "UNIVERSITY POLICE" in u or "COMMUNITY COLLEGE" in u:
        return "CAMPUS_POLICE"
    if "POLICE" in u:
        return "LOCAL_POLICE"
    if "FIRE" in u:
        return "FIRE"
    if "AMBULANCE" in u or "EMS" in u or "NURSE NAVIGATION" in u:
        return "EMS"
    if "911" in u:
        return "OTHER_911_CENTER"
    return "OTHER"


# ---------------------------------------------------------------------------------------------
# Response types

MPDS_DESC_SYNONYMS = {"ALLERGIES/ENVENOMATIONS": "ALLERGIES/ENVENOMATION", "CUT OFF RING REQUEST": "CUT-OFF RING REQUEST"}
MPDS_RE = re.compile(r"^(\d{2})([A-EO])(\d{2})([A-Z]?)\s*-\s*(.*)$")
MPDS_LEVEL_RANK = {"O": 0, "A": 1, "B": 2, "C": 3, "D": 4, "E": 5}

# Format B (2026) wording -> format A (2024-25) wording, so the two eras share one vocabulary.
TYPE_SYNONYMS = {
    "SUSPICIOUS ACTIVITY": "SUSP ACTIVITY",
    "SUSPICIOUS PACKAGE": "SUSP PACKAGE",
    "INVESTIGATION": "INVESTIGATE",
    "DRUG INV/POSSESION": "NARCOTIC INV/POSSESSION",
    "VTL COMPLAINT": "VEHICLE TRAFFIC LAW",
    "K9 ASSIST": "K9",
    "CELLAR PUMP": "PUMP CELLAR",
    "MVA-PI DIVIDED HIGHWAY": "MVA-PI-DIVIDED HWY",
    "MUTUAL AID-CASCADE": "MUTUAL AID CASCADE",
    "ACCIDENT FARM": "FARM ACCIDENT",
    "FIRE BRUSH": "FIRE GRASS/TREE",
    "FIRE STRUCTURE-WORKING FIRE": "FIRE STRUCTURE",
    "CONTRABAND": "PRISON CONTRABAND",
    "FORCIBLE ENTRY": "FORCIBLE ENTRY/NON EMS",
    "PROPERTY FOUND": "PROPERTY FOUND/LOST",
    "PROPERTY LOST": "PROPERTY FOUND/LOST",
    "ODOR OF GAS INSIDE": "GAS ODOR/ALARM BUILDING",
    "CUSTODIAL ABDUCTION": "CUSTODIAL INTERFERENCE",
    "CUSTODY ISSUE": "CUSTODIAL INTERFERENCE",
    "TRAFFIC HAZARD": "TRAFFIC",
    "NURSENAV-ALS": "NURSENAV",
}

CATEGORY_RULES = [  # (category, exact names or regex prefixes); first match wins
    ("MENTAL_HEALTH", ["MHL", "CHECK WELFARE - EDP", "CHECK WELFARE-EDP", "EVALUATION", "SUICIDE", "SUICIDE ATTEMPT"]),
    ("MEDICAL", ["EMS CALL", "ALARM EMS", "OVERDOSE", "NURSENAV", "ALS LINK UP", "MUTUAL AID EMS", "BURN INJURY",
                 "DEATH", "LANDING ZONE"]),
    ("FIRE_HAZARD", [r"^FIRE (?!POLICE)", "ALARM CARBON MONOXIDE", "GAS ODOR/ALARM BUILDING", r"^ODOR OF",
                     "WIRES DOWN/BURN", "TREE DOWN", "SPILL/LEAK", "HAZMAT", r"^MUTUAL AID (FIRE|CASCADE)",
                     "PUMP CELLAR", "WATER RESCUE", "ELEVATOR RESCUE", "RESCUE", "BLDG COLLAPSE", "FLOODING",
                     "ILLEGAL BURN", "FIRE POLICE", "DECON", "EVACUATION", "WATER BREAK", "SUPERVISORY ALARM",
                     "FORCIBLE ENTRY/NON EMS", "COLLEGE ALARM"]),
    ("TRAFFIC", ["TRAFFIC STOP", r"^MVA", "TRAFFIC", "TRAFFIC DETAIL", "DISABLED VEHICLE", "ASSIST MOTORIST",
                 "VEHICLE TRAFFIC LAW", "PARKING SUMMONS", "ABANDONED VEHICLE", r"^ACCIDENT ", "TOWING", "DWI",
                 "FARM ACCIDENT", "CITIZEN STOP"]),
    ("VIOLENT_CRIME", [r"^ASSAULT", "SHOTS FIRED", "FIGHT", r"^ROBBERY", r"^MENACING", r"^RAPE", "SEX OFFENSE",
                       r"^ABDUCTION", "HOME INVASION", "WEAPON POSSESSION", "STALKING", "BOMB THREAT"]),
    ("PROPERTY_CRIME", [r"^LARCENY", r"^BURGLARY", "CRIM MISCHIEF", "VEHICLE STOLEN", "UNAUTHORIZED USE", "FRAUD",
                        "IDENTITY THEFT", "COUNTERFEITING", "FORGERY", "BAD CHECK", "THEFT OF SERVICE",
                        "PROPERTY DAMAGE", r"^TRESPASS", "LOST/STLN PLATE", "PROPERTY STOLEN", "ILLEGAL DUMPING",
                        "LITTERING", "TAMPERING", "REPOSSESSION"]),
    ("DOMESTIC_DISPUTE", [r"^DOMESTIC", r"^DISPUTE", "NEIGHBOR PROBLEM", "ORDER OF PROTECTION",
                          "CUSTODIAL INTERFERENCE", "CIVIL", "CRIM CONTEMPT", r"^HARASSMENT", "COURT ORDER"]),
    ("PUBLIC_ORDER", ["NOISE COMPLAINT", r"^DISCON", "FIREWORKS", "ABC COMPLAINT", "PUBLIC LEWDNESS",
                      "RECKLESS ACTIVITY", "JUVENILE", "RUNAWAY", "SUSP ACTIVITY", "SUSP PACKAGE",
                      "NARCOTIC INV/POSSESSION", "MARIJUANA", "SOLICITATION", "TOBACCO DETAIL", "CODE VIOLATION",
                      "PRISON CONTRABAND", "FALSE REPORTING", "CRIM IMPERSONATION"]),
    ("WELFARE_ASSIST", ["CHECK WELFARE", "ASSIST", "MISSING PERSON", "FOUND PERSON", "LOCKOUT", "STANDBY",
                        "PEACE OFFICER", "ABUSE", "NEGLECT", "ENDANGER WELFARE", "ABANDONMENT", "AIDED CASE",
                        "DSS HOME VISIT", "ESCORT", "SEARCH", "BOAT ASSIST", "NOTIFICATION", "OPEN DOOR/WINDOW",
                        "TRANSPORT"]),
    ("ALARM", ["ALARM POLICE"]),
    ("ANIMAL", [r"^ANIMAL"]),
    ("ADMIN_PROACTIVE", ["PREMISE CK", "AREA CK", "INVESTIGATE", "WARRANT", "SUMMONS", "SUBPOENA SERVED",
                         "BACKGROUND INV", "PISTOL PERMIT", r"^SORA", "DETAIL", "WATER DETAIL", "DATA",
                         "RECORDS CHECK", "ATL", "BOLO", "K9", "ARREST", "TEST", "TRAINING", "INTERNAL",
                         "DO NOT TAG", "POLYGRAPH", "PERSONNEL COMP", "PROBATION VIOLATION", "FAILURE TO COMPLY",
                         "WEAPON SURRENDER", "PROPERTY FOUND/LOST", "PROPERTY RECOVERED", "VEHICLE RECOVERED",
                         "BUILDING INSPECTION", "FIRE INSPECTION", "NAVIGATIONAL", "CAC", "ENCON", "SSALERT",
                         "CODE 20"]),
    ("CALL_ISSUE", ["ABANDONED CALL", "OTHER", "UNKNOWN"]),
]


def categorize(std):
    for cat, rules in CATEGORY_RULES:
        for r in rules:
            if (r.startswith("^") and re.match(r, std)) or std == r:
                return cat
    return "UNCATEGORIZED"


def parse_type(cleaned):
    """-> (response_type_std, mpds_code, protocol, level, suffix, description, in_progress)"""
    t = cleaned.upper()
    m = MPDS_RE.match(t)
    if m:
        proto, level, num, suffix, desc = m.groups()
        code = f"{proto}{level}{num}{suffix}"
        desc = desc.lstrip("- ")
        desc = MPDS_DESC_SYNONYMS.get(desc, desc)
        return f"{code}-{desc}", code, int(proto), level, suffix, desc, False
    t = re.sub(r"\s*-\s*", "-", t) if not t.startswith("CHECK WELFARE") else t
    in_progress = t.endswith(" IN PROGRESS")
    base = t[: -len(" IN PROGRESS")] if in_progress else t
    base = TYPE_SYNONYMS.get(base, base)
    return base, "", None, "", "", "", in_progress


# ---------------------------------------------------------------------------------------------
# Locations

COORD_RE = re.compile(r"(-?\d{2}\.\d+)\s*~\s*(-?\s*\d{2,3}\.\d+)")
CITY_FIX = {"ROME OUTISIDE": "ROME OUTSIDE", "NEW YORK MILLS NEW HARTFO": "NEW YORK MILLS NEW HARTFORD",
            "WESTMORELAN D": "WESTMORELAND"}
DIRS = {"NORTH": "N", "SOUTH": "S", "EAST": "E", "WEST": "W"}
STREET_SUFFIXES = {"ST", "RD", "AVE", "BLVD", "DR", "LN", "PL", "CT", "CIR", "TER", "WAY", "PKWY", "PKY", "HWY",
                   "TPKE", "PK", "PARK", "SQ", "TRL", "LOOP", "PLZ", "ROW", "XING", "EXT"}


def std_street(s):
    s = s.upper().strip()
    s = re.sub(r"^(STATE ROUTE|UNITED STATES ROUTE|US ROUTE|NYS ROUTE)\b", "ROUTE", s)
    toks = s.split()
    if len(toks) >= 3 and toks[0] in DIRS:
        toks[0] = DIRS[toks[0]]
    if len(toks) >= 3 and toks[-1] in ("EAST", "WEST"):
        toks[-1] = DIRS[toks[-1]]
    if len(toks) >= 3 and toks[0] == "SAINT":
        toks[0] = "ST"
    # 2024-25 reports put a trailing direction before the suffix ("ERIE W BLVD"); use "ERIE BLVD W" like 2026/USPS.
    if len(toks) >= 3 and toks[-2] in ("N", "S", "E", "W") and toks[-1] in STREET_SUFFIXES:
        toks[-2], toks[-1] = toks[-1], toks[-2]
    return " ".join(toks)


# Reported city -> (town, village, district, county). In New York, villages lie inside towns; Utica, Rome and
# Sherrill are cities. Village-to-town assignments follow Census TIGER boundaries (Waterville is mostly in
# Sangerfield, Remsen village mostly in Remsen town). The dispatch system splits Rome into its Inside (inner) and
# Outside (outer) districts and New York Mills by the town each part lies in.
CITY_PARTS = {
    "ROME": ("ROME", "", "", "ONEIDA"),
    "ROME INSIDE": ("ROME", "", "INSIDE", "ONEIDA"),
    "ROME OUTSIDE": ("ROME", "", "OUTSIDE", "ONEIDA"),
    "TRENTON HINCKLEY": ("TRENTON", "", "HINCKLEY", "ONEIDA"),
    "NEW YORK MILLS NEW HARTFORD": ("NEW HARTFORD", "NEW YORK MILLS", "", "ONEIDA"),
    "NEW YORK MILLS WHITESTOWN": ("WHITESTOWN", "NEW YORK MILLS", "", "ONEIDA"),
    "ONEIDA COUNTY": ("", "", "", "ONEIDA"),
    # Mutual aid into neighboring counties
    "ONEIDA CITY INSIDE": ("ONEIDA CITY", "", "INSIDE", "MADISON"),
    "MADISON VILLAGE": ("MADISON", "MADISON", "", "MADISON"),
    "HERKIMER COUNTY": ("", "", "", "HERKIMER"),
    "OHIO": ("OHIO", "", "", "HERKIMER"),
    "POLAND VILLAGE": ("", "POLAND", "", "HERKIMER"),
    "POLAND VILLAGE HERKIMER CO": ("", "POLAND", "", "HERKIMER"),
    "WEST WINFIELD VILLAGE": ("WINFIELD", "WEST WINFIELD", "", "HERKIMER"),
    "CLEVELAND OSWEGO CO": ("CONSTANTIA", "CLEVELAND", "", "OSWEGO"),
    "CONSTANTIA OSWEGO COUNTY": ("CONSTANTIA", "", "", "OSWEGO"),
    "PULASKI": ("RICHLAND", "PULASKI", "", "OSWEGO"),
    "WEST LEYDEN": ("", "", "WEST LEYDEN", "LEWIS"),
}
VILLAGE_TOWN = {
    "BARNEVELD": "TRENTON", "BOONVILLE": "BOONVILLE", "CAMDEN": "CAMDEN", "CLAYVILLE": "PARIS",
    "CLINTON": "KIRKLAND", "HOLLAND PATENT": "TRENTON", "NEW HARTFORD": "NEW HARTFORD", "ONEIDA CASTLE": "VERNON",
    "ORISKANY": "WHITESTOWN", "ORISKANY FALLS": "AUGUSTA", "REMSEN": "REMSEN", "SYLVAN BEACH": "VIENNA",
    "VERNON": "VERNON", "WATERVILLE": "SANGERFIELD", "WHITESBORO": "WHITESTOWN", "YORKVILLE": "WHITESTOWN",
}


def city_parts(city):
    """-> (town, village, district, county) for a reported city value."""
    if not city:
        return "", "", "", ""
    if city in CITY_PARTS:
        return CITY_PARTS[city]
    if city.endswith(" VILLAGE"):
        v = city[: -len(" VILLAGE")]
        if v in VILLAGE_TOWN:
            return VILLAGE_TOWN[v], v, "", "ONEIDA"
        raise ValueError(f"village with no town mapping: {city}")
    return city, "", "", "ONEIDA"  # a town, or the cities of Utica and Sherrill


# ---------------------------------------------------------------------------------------------

def main():
    raw = pd.read_csv(OUT / "raw_records.csv", dtype=str, keep_default_na=False)
    vocab = build_vocab([raw.agency, raw.response_type, raw.location, raw.city])

    df = pd.DataFrame()
    df["source_file"] = raw.source_file
    df["report_date"] = raw.report_date
    df["report_format"] = raw.report_format
    df["page"] = raw.page.astype(int)
    df["row_in_file"] = raw.row_in_file.astype(int)

    # Report versions: September-24-2026-v2.pdf supersedes September-24-2026.pdf.
    stem = raw.source_file.str.replace(r"-v\d+\.pdf$", ".pdf", regex=True)
    version = raw.source_file.str.extract(r"-v(\d+)\.pdf$")[0].fillna("1").astype(int)
    latest = version.groupby(stem).transform("max")
    df["report_version"] = version
    superseded = version < latest

    dt_txt = raw.datetime.str.replace("\n", " ").str.replace(r"\s+", " ", regex=True).str.strip()
    has_sec = dt_txt.str.match(r".* \d\d:\d\d:\d\d$")
    dt = pd.to_datetime(dt_txt, format="%m/%d/%Y %H:%M:%S", errors="coerce")
    dt = dt.fillna(pd.to_datetime(dt_txt, format="%m/%d/%Y %H:%M", errors="coerce"))
    df["call_datetime"] = dt.dt.strftime("%Y-%m-%d %H:%M:%S")
    df["time_precision"] = has_sec.map({True: "second", False: "minute"})

    # Agency: format B truncates names in the row but prints the full name in the group header.
    agency_raw = raw.agency.map(lambda c: join_lines(c, vocab))
    agency_src = agency_raw.where(raw.agency_group == "", raw.agency_group)
    df["agency_raw"] = agency_raw
    df["agency"] = agency_src.map(canon_agency)
    df["agency_type"] = df.agency.map(agency_type)

    # Response type
    rt = raw.response_type.map(lambda c: join_lines(c, vocab))
    df["response_type_raw"] = rt
    parsed = rt.map(parse_type)
    df["response_type"] = [p[0] for p in parsed]
    df["in_progress"] = [p[6] for p in parsed]
    df["is_mpds"] = [p[1] != "" for p in parsed]
    df["mpds_code"] = [p[1] for p in parsed]
    df["mpds_protocol"] = pd.array([p[2] for p in parsed], dtype="Int64")
    df["mpds_protocol_name"] = df.mpds_protocol.map(lambda x: MPDS_PROTOCOLS.get(int(x), "") if pd.notna(x) else "")
    df["mpds_level"] = [p[3] for p in parsed]
    df["mpds_level_rank"] = pd.array([MPDS_LEVEL_RANK.get(p[3]) for p in parsed], dtype="Int64")
    df["mpds_description"] = [p[5] for p in parsed]
    df["category"] = [("MEDICAL" if p[1] and p[2] <= 37 else
                       "FIRE_HAZARD" if p[1] else categorize(p[0])) for p in parsed]

    # Location / coordinates
    loc = raw.location.map(lambda c: join_lines(c, vocab))
    coords = loc.str.extract(COORD_RE)
    df["latitude"] = pd.to_numeric(coords[0], errors="coerce")
    df["longitude"] = pd.to_numeric(coords[1].str.replace(" ", ""), errors="coerce")
    loc_clean = loc.where(coords[0].isna(), "")
    df["location_raw"] = loc
    df["street"] = loc_clean.map(std_street)
    df["is_intersection"] = df.street.str.contains(" / ", regex=False)
    city = raw.city.map(lambda c: join_lines(c, vocab)).str.upper().replace(CITY_FIX)
    df["city"] = city
    parts = city.map(city_parts)
    df["town"] = [p[0] for p in parts]
    df["village"] = [p[1] for p in parts]
    df["district"] = [p[2] for p in parts]
    df["county"] = [p[3] for p in parts]
    df["outside_county"] = df.county.ne("ONEIDA") & df.county.ne("")
    df["location_missing"] = (df.street == "") & df.latitude.isna()

    # Time features
    df["year"] = dt.dt.year
    df["month"] = dt.dt.month
    df["day"] = dt.dt.day
    df["hour"] = dt.dt.hour
    df["minute"] = dt.dt.minute
    df["day_of_week"] = dt.dt.dayofweek  # 0 = Monday
    df["day_name"] = dt.dt.day_name()
    df["is_weekend"] = df.day_of_week >= 5
    df["week_of_year"] = dt.dt.isocalendar().week.astype(int)
    df["day_of_year"] = dt.dt.dayofyear
    angle = 2 * np.pi * (df.hour + df.minute / 60) / 24
    df["hour_sin"] = np.sin(angle).round(6)
    df["hour_cos"] = np.cos(angle).round(6)

    df = df[~superseded].copy()
    df["_dt"] = dt[~superseded]

    # Incident clustering: several agencies dispatched to one emergency appear as separate rows with the same
    # type and place within a short window. Heuristic; rows with no location only cluster when nearly simultaneous.
    df = df.sort_values(["_dt", "source_file", "row_in_file"]).reset_index(drop=True)
    df["_place"] = df.street + "|" + df.city
    cluster = [0] * len(df)
    next_id = 0
    open_by_key = {}  # (type, place) -> (cluster id, last time)
    for i, (t, typ, place, has_loc) in enumerate(zip(df._dt, df.response_type, df._place, ~df.location_missing)):
        window = 120 if has_loc else 5
        key = (typ, place if has_loc else "")
        prev = open_by_key.get(key)
        if prev and (t - prev[1]).total_seconds() <= window:
            cluster[i] = prev[0]
        else:
            next_id += 1
            cluster[i] = next_id
        open_by_key[key] = (cluster[i], t)
    df["incident_cluster_id"] = cluster
    df["agencies_in_cluster"] = df.groupby("incident_cluster_id").agency.transform("nunique")
    df["record_id"] = range(1, len(df) + 1)

    cols = ["record_id", "call_datetime", "time_precision", "year", "month", "day", "hour", "minute",
            "day_of_week", "day_name", "is_weekend", "week_of_year", "day_of_year", "hour_sin", "hour_cos",
            "agency", "agency_type", "category", "response_type", "in_progress",
            "is_mpds", "mpds_code", "mpds_protocol", "mpds_protocol_name", "mpds_level", "mpds_level_rank",
            "mpds_description", "street", "is_intersection", "city", "town", "village", "district", "county",
            "outside_county", "latitude", "longitude",
            "location_missing", "incident_cluster_id", "agencies_in_cluster",
            "agency_raw", "response_type_raw", "location_raw",
            "report_date", "report_format", "report_version", "source_file", "page", "row_in_file"]
    df[cols].to_csv(OUT / "oneida_911_records.csv", index=False, encoding="utf-8")

    tm = (df.groupby(["response_type_raw", "response_type", "category", "report_format"]).size()
          .rename("count").reset_index().sort_values("count", ascending=False))
    tm.to_csv(OUT / "response_type_map.csv", index=False)
    am = (df.groupby(["agency_raw", "agency", "agency_type", "report_format"]).size()
          .rename("count").reset_index().sort_values("count", ascending=False))
    am.to_csv(OUT / "agency_map.csv", index=False)

    print(f"raw rows {len(raw)}, superseded-version rows dropped {int(superseded.sum())}, final {len(df)}")
    print(f"bad datetimes {dt.isna().sum()}, incident clusters {df.incident_cluster_id.nunique()}")
    print("uncategorized:", df[df.category == "UNCATEGORIZED"].response_type.value_counts().to_dict())
    print(df.category.value_counts().to_string())
    for col in ["agency", "response_type", "street", "city"]:
        odd = Counter(w for v in df[col] for w in SPLIT.split(v) if w and vocab[w] == 0 and not w.isdigit())
        print(f"{col}: words never seen away from a line break ->", odd.most_common(15))


if __name__ == "__main__":
    main()
